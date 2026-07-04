//! The push-stream IPC commands — the Rust port of the Deno SSE / NDJSON routes
//! (`events.ts`, `logs.ts`, and the install stream in `[action].ts`), driven over
//! `tauri::ipc::Channel` instead of an HTTP response body.
//!
//! Each command spawns a pump task and registers its `AbortHandle` under a returned
//! subscription id, so the frontend can `unsubscribe` and window teardown can stop
//! every pump — the explicit lifecycle that replaces Phase 0's fire-and-forget
//! streams. A pump also self-terminates when its `Channel::send` fails (the webview /
//! receiver went away).

use std::time::Duration;

use compositz_core::{
    EngineHandle, build_snapshot, event_stream, install_instance, instance_container_name,
    instance_image_tag, is_valid_instance_id, log_stream,
};
use futures_util::StreamExt;
use serde::Serialize;
use tauri::State;
use tauri::ipc::Channel;

use crate::commands::load_by_id;
use crate::error::AppError;
use crate::state::AppState;
use compositz_core::ContainerStatus;

// Refresh cadences (parity with the Deno events.ts constants).
const WARMING_TICK: Duration = Duration::from_millis(2_000); // poll rate while a port is warming
const SAFETY_REFRESH: Duration = Duration::from_millis(15_000); // backstop re-push when idle
const RECONNECT: Duration = Duration::from_millis(2_000); // backoff after the event stream ends

// --- event payloads (each `type`-tagged for a TS discriminated union) ------

/// A managed-container snapshot push, or an engine-offline notice — mirrors the Deno
/// events.ts SSE `snapshot` / `offline` events.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SnapshotEvent {
    Snapshot { containers: Vec<ContainerStatus> },
    Offline { error: String },
}

/// One line of a container's logs, the end-of-stream marker, or an error — mirrors
/// the Deno logs.ts SSE `log` / `end` / `logerror` events. (Core's `log_stream`
/// yields already-demuxed lines, so there is no per-line stdout/stderr tag.)
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LogEvent {
    Log { line: String },
    End,
    Error { error: String },
}

/// One line of build output, the built image tag on success, or an error — mirrors
/// the Deno install NDJSON (`{type:"log"}` … `{type:"done"}` / `{type:"error"}`).
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum InstallEvent {
    Log { line: String },
    Done { tag: String },
    Error { error: String },
}

// --- commands -------------------------------------------------------------

/// Subscribe to managed-container snapshots. Returns a subscription id; the pump runs
/// until `unsubscribe(id)`, window teardown, or the receiver is dropped.
#[tauri::command]
#[specta::specta]
pub async fn subscribe_instances(
    state: State<'_, AppState>,
    on_event: Channel<SnapshotEvent>,
) -> Result<u32, AppError> {
    let engine = state.engine.clone();
    let store = state.store.clone();
    let task = tokio::spawn(snapshot_pump(engine, store, on_event));
    Ok(register(&state, task.abort_handle()))
}

/// Stream a RUNNING container's logs (validated id → container name). Returns a
/// subscription id.
#[tauri::command]
#[specta::specta]
pub async fn stream_logs(
    state: State<'_, AppState>,
    id: String,
    on_log: Channel<LogEvent>,
) -> Result<u32, AppError> {
    // ★ F5: validate before the id becomes a container name reaching the engine.
    if !is_valid_instance_id(&id) {
        return Err(AppError::bad_request(format!("invalid instance id: {id}")));
    }
    let engine = state.engine.clone();
    let name = instance_container_name(&id);
    let task = tokio::spawn(async move {
        let mut stream = log_stream(&engine, &name);
        while let Some(item) = stream.next().await {
            match item {
                Ok(line) => {
                    if on_log.send(LogEvent::Log { line }).is_err() {
                        return; // receiver gone
                    }
                }
                Err(e) => {
                    let _ = on_log.send(LogEvent::Error {
                        error: e.to_string(),
                    });
                    return;
                }
            }
        }
        let _ = on_log.send(LogEvent::End);
    });
    Ok(register(&state, task.abort_handle()))
}

/// Build (or pull) an instance's image, streaming the build log. Returns a
/// subscription id. Mirrors the Deno install stream.
#[tauri::command]
#[specta::specta]
pub async fn instance_install(
    state: State<'_, AppState>,
    id: String,
    on_progress: Channel<InstallEvent>,
) -> Result<u32, AppError> {
    // ★ F5 + reconcile before we build against a store-loaded definition.
    let instance = load_by_id(&state.store, &id)?;
    let engine = state.engine.clone();
    let tag = instance_image_tag(&instance.manifest, &instance.instance_id);
    let task = tokio::spawn(async move {
        let mut stream = install_instance(&engine, &instance);
        while let Some(item) = stream.next().await {
            match item {
                Ok(progress) => {
                    if let Some(line) = progress.stream
                        && on_progress.send(InstallEvent::Log { line }).is_err()
                    {
                        return; // receiver gone
                    }
                    if let Some(error) = progress.error {
                        let _ = on_progress.send(InstallEvent::Error { error });
                        return; // a build failure reported in-stream
                    }
                }
                Err(e) => {
                    let _ = on_progress.send(InstallEvent::Error {
                        error: e.to_string(),
                    });
                    return;
                }
            }
        }
        let _ = on_progress.send(InstallEvent::Done { tag });
    });
    Ok(register(&state, task.abort_handle()))
}

/// Stop a subscription's pump (idempotent). Called on tab close / component unmount.
#[tauri::command]
#[specta::specta]
pub async fn unsubscribe(state: State<'_, AppState>, subscription_id: u32) -> Result<(), AppError> {
    state
        .streams
        .lock()
        .expect("stream registry mutex poisoned")
        .abort(subscription_id);
    Ok(())
}

// --- pump + helpers -------------------------------------------------------

/// Push managed-container snapshots on a SINGLE loop: after each push, wait for the
/// next relevant Docker event OR a refresh tick (fast while `warming`, else the slow
/// safety backstop), then push again. A single pusher structurally rules out the
/// stale-wins race the Deno events.ts guarded with serialize+coalesce — there is
/// never more than one snapshot in flight. The event stream is re-opened after it
/// ends/errors (reconnect backoff). Ends when a `Channel::send` fails or the task is
/// aborted mid-await.
async fn snapshot_pump(engine: EngineHandle, store: String, channel: Channel<SnapshotEvent>) {
    let mut events = event_stream(&engine);
    loop {
        let warming = match build_snapshot(&engine, &store).await {
            Ok(snapshot) => {
                let event = SnapshotEvent::Snapshot {
                    containers: snapshot.containers,
                };
                if channel.send(event).is_err() {
                    return;
                }
                snapshot.warming
            }
            Err(e) => {
                if channel
                    .send(SnapshotEvent::Offline {
                        error: e.to_string(),
                    })
                    .is_err()
                {
                    return;
                }
                false
            }
        };

        let idle = if warming {
            WARMING_TICK
        } else {
            SAFETY_REFRESH
        };
        tokio::select! {
            item = events.next() => {
                if item.is_none() {
                    // Stream ended / engine unreachable — reconnect after a backoff.
                    tokio::time::sleep(RECONNECT).await;
                    events = event_stream(&engine);
                }
                // Any event (or an error item) → loop → re-push a fresh snapshot.
            }
            _ = tokio::time::sleep(idle) => {
                // Warming poll or safety backstop → re-push.
            }
        }
    }
}

/// Register a pump task under a fresh subscription id.
fn register(state: &AppState, handle: tokio::task::AbortHandle) -> u32 {
    state
        .streams
        .lock()
        .expect("stream registry mutex poisoned")
        .register(handle)
}
