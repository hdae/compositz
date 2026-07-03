//! Compositz desktop backend (Tauri 2) — Phase 0 walking skeleton.
//!
//! Exposes three commands over the fixed IPC contract:
//!   - `list_containers` — request/response list of managed containers,
//!   - `stream_logs` / `stream_events` — push streams over `tauri::ipc::Channel`.
//!
//! This crate links webkit2gtk/dbus and therefore compiles only in CI
//! (windows-latest) / on a desktop OS — never in the headless dev container.
//! It is validated locally by `cargo metadata` + `cargo tree` and by review.

use compositz_core::{ContainerSummary, EngineHandle};
use futures_util::StreamExt;
use tauri::{Manager, State, ipc::Channel};

/// Managed application state. Phase 0 holds only the engine handle; the
/// `Mutex<AppState>` from the migration plan arrives with the ported core in
/// later phases.
struct AppState {
    engine: EngineHandle,
}

/// List Compositz-managed containers (running and stopped).
#[tauri::command]
async fn list_containers(state: State<'_, AppState>) -> Result<Vec<ContainerSummary>, String> {
    compositz_core::list_instances(&state.engine)
        .await
        .map_err(|e| e.to_string())
}

/// Start streaming a container's logs into `on_log` (one line per message).
///
/// Returns as soon as the pump task is spawned. The task is fire-and-forget for
/// Phase 0; per-stream lifecycle/cancellation is a Phase 3 concern (see the
/// concern noted in the migration report).
#[tauri::command]
async fn stream_logs(
    state: State<'_, AppState>,
    container_id: String,
    on_log: Channel<String>,
) -> Result<(), String> {
    let engine = state.engine.clone();
    tokio::spawn(async move {
        let mut stream = compositz_core::log_stream(&engine, &container_id);
        while let Some(item) = stream.next().await {
            match item {
                Ok(line) => {
                    if on_log.send(line).is_err() {
                        // Receiver (webview) went away — stop pumping.
                        break;
                    }
                }
                Err(e) => {
                    let _ = on_log.send(format!("[log stream error] {e}"));
                    break;
                }
            }
        }
    });
    Ok(())
}

/// Start streaming the daemon's system events into `on_event` (one compact
/// summary line per message). Same fire-and-forget lifecycle as `stream_logs`.
#[tauri::command]
async fn stream_events(
    state: State<'_, AppState>,
    on_event: Channel<String>,
) -> Result<(), String> {
    let engine = state.engine.clone();
    tokio::spawn(async move {
        let mut stream = compositz_core::event_stream(&engine);
        while let Some(item) = stream.next().await {
            match item {
                Ok(summary) => {
                    if on_event.send(summary).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    let _ = on_event.send(format!("[event stream error] {e}"));
                    break;
                }
            }
        }
    });
    Ok(())
}

/// Build and run the Tauri application.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Connect to the engine at startup; a failure here is fatal for the
            // walking skeleton (a manager with no engine can do nothing). Later
            // phases can degrade gracefully and surface a connection banner.
            let engine = compositz_core::connect()?;
            app.manage(AppState { engine });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_containers,
            stream_logs,
            stream_events
        ])
        .run(tauri::generate_context!())
        .expect("error while running Compositz");
}
