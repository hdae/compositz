//! The non-streaming request/response IPC commands (the streaming commands live in
//! `stream.rs`, driven over the Channel pump).
//!
//! Every command that accepts an instance id MUST validate it at the boundary BEFORE
//! it reaches a filesystem path or a destructive engine op: the core lifecycle fns
//! take a raw `&str`, so this boundary is the guard. [`load_by_id`] validates +
//! reconciles the loaded id; the direct-id commands validate inline. The heavy
//! blocking ingest paths run under `spawn_blocking`, off the async runtime.

use compositz_core::brand::label;
use compositz_core::{
    BundleSource, EngineSnapshot, GithubIngestOpts, IngestOpts, Instance, InstanceRow,
    InstanceSettings, InstanceView, LaunchConfig, Override, PortBump, RemoveDataOpts,
    UpdatePreview, build_settings, commit_update, deconflict_host_ports, defined_host_ports,
    discard_update, down, duplicate_instance, export_mount as core_export_mount, ingest_bundle,
    ingest_github, install_instance, instance_image_tag, is_valid_instance_id, list_instances,
    load_instance, load_instance_config, load_launched_config, prepare_update,
    remove_instance_data, remove_instance_dir, remove_instance_image, remove_superseded_image,
    same_override, save_instance_config, set_instance_name, to_container_statuses,
    to_instance_rows, to_instance_view, up, validate_override, web_url,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::io::Write;
use tauri::State;
use tauri_plugin_opener::OpenerExt;

use crate::error::AppError;
use crate::state::AppState;

// --- DTOs -----------------------------------------------------------------

/// The result of bringing an instance up.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UpView {
    pub id: String,
    pub used_gpu: bool,
    /// The primary web UI URL, if the recipe publishes one (built from the ports
    /// ACTUALLY published after any conflict bump).
    pub url: Option<String>,
}

/// A freshly-created instance for the trust prompt: the view plus any host-port
/// reassignments to disclose. Shared by import (file + GitHub) and duplicate.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportView {
    pub view: InstanceView,
    pub bumps: Vec<PortBump>,
}

/// The outcome of a delete: a non-fatal partial-outcome warning, if any (host data
/// left behind, unreadable definition). A hard failure is an `AppError` instead.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DeleteView {
    pub warning: Option<String>,
}

/// Delete options: remove the data volumes, and the host-browsable bind data.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DeleteOpts {
    pub volumes: bool,
    pub bind_data: bool,
}

/// The result of saving a config override: whether a restart is needed to apply it.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SetConfigView {
    pub restart_needed: bool,
}

// --- shared helpers -------------------------------------------------------

/// Load an instance for a URL id, validating against the id charset (the single
/// source of truth) and reconciling the loaded id with the requested id — so a
/// path-shaped id can neither traverse out of the store nor load an unintended
/// instance. Shared with the streaming `instance_install`.
pub(crate) fn load_by_id(store: &str, id: &str) -> Result<Instance, AppError> {
    if !is_valid_instance_id(id) {
        return Err(AppError::bad_request(format!("invalid instance id: {id}")));
    }
    let instance = load_instance(&format!("{store}/{id}"))?;
    if instance.instance_id != id {
        return Err(AppError::bad_request(format!(
            "instance id mismatch: requested \"{id}\" vs loaded \"{}\"",
            instance.instance_id
        )));
    }
    Ok(instance)
}

/// Whether the saved override differs from what the (running) instance was last
/// launched with — a restart is needed iff the instance was launched and its saved
/// config has diverged.
fn restart_needed(instance: &Instance, saved: &Override) -> Result<bool, AppError> {
    let launched = load_launched_config(&instance.dir)?;
    Ok(launched.is_some_and(|l| !same_override(saved, &l)))
}

/// Reject any override section key that does not name a manifest item of `kind`.
fn check_known_keys<V>(
    section: Option<&std::collections::BTreeMap<String, V>>,
    known: &[String],
    kind: &str,
) -> Result<(), AppError> {
    if let Some(map) = section {
        for key in map.keys() {
            if !known.contains(key) {
                return Err(AppError::bad_request(format!("unknown {kind} \"{key}\"")));
            }
        }
    }
    Ok(())
}

/// Reject any override key that does not name a manifest port / env / mount.
fn assert_known_keys(instance: &Instance, over: &Override) -> Result<(), AppError> {
    let m = &instance.manifest;
    let port_names: Vec<String> = m.ports.iter().map(|p| p.name.clone()).collect();
    let env_names: Vec<String> = m.env.iter().map(|e| e.name.clone()).collect();
    let mount_names: Vec<String> = m.mounts.iter().map(|mt| mt.name.clone()).collect();
    check_known_keys(over.host_ports.as_ref(), &port_names, "port")?;
    check_known_keys(over.env.as_ref(), &env_names, "env")?;
    check_known_keys(over.placement.as_ref(), &mount_names, "mount")?;
    Ok(())
}

/// Build the initial full snapshot (managed containers + which instance image tags
/// exist locally). Returns `Err` when the engine is unreachable, so the caller can
/// degrade to a `None` snapshot (installed unknown) instead of failing the load.
async fn engine_snapshot(
    state: &AppState,
    views: &[InstanceView],
) -> Result<EngineSnapshot, AppError> {
    let raw = state.engine.list_managed_raw().await?;
    let containers = to_container_statuses(&raw, &label("instance"));
    let mut installed_tags = Vec::new();
    for view in views {
        if state.engine.image_exists(&view.image_tag).await? {
            installed_tags.push(view.image_tag.clone());
        }
    }
    Ok(EngineSnapshot {
        containers,
        installed_tags,
    })
}

// --- commands -------------------------------------------------------------

/// The initial dashboard: every stored instance as a row, joined with a live engine
/// read (running + installed). When the engine is unreachable the rows still list
/// (installed unknown, nothing running). The live/probed updates arrive over
/// `subscribe_instances`.
#[tauri::command]
#[specta::specta]
pub async fn list_instance_rows(state: State<'_, AppState>) -> Result<Vec<InstanceRow>, AppError> {
    let instances = list_instances(&state.store);
    let mut views = Vec::with_capacity(instances.len());
    for instance in &instances {
        let over = load_instance_config(&instance.dir)?;
        views.push(to_instance_view(instance, &over));
    }
    // Engine unreachable → None snapshot (installed unknown), never a failed load.
    let snapshot = engine_snapshot(&state, &views).await.ok();
    Ok(to_instance_rows(&views, snapshot.as_ref()))
}

/// Bring an instance up: build the image if it is missing (drained silently — the
/// explicit build-with-log path is `instance_install`), create + start, and return
/// the published web URL.
#[tauri::command]
#[specta::specta]
pub async fn instance_up(state: State<'_, AppState>, id: String) -> Result<UpView, AppError> {
    let instance = load_by_id(&state.store, &id)?;
    let tag = instance_image_tag(&instance.manifest, &instance.instance_id);
    if !state.engine.image_exists(&tag).await? {
        let mut stream = install_instance(&state.engine, &instance);
        while let Some(item) = stream.next().await {
            item?; // propagate a build failure
        }
    }
    let result = up(&state.engine, &instance, &LaunchConfig::default()).await?;
    let launch = LaunchConfig {
        host_ports: result.host_ports.clone(),
        ..Default::default()
    };
    Ok(UpView {
        id: result.id,
        used_gpu: result.used_gpu,
        url: web_url(&instance.manifest, &launch),
    })
}

/// Stop + remove an instance's container. The id is validated at the boundary before
/// it reaches the engine op (every command that accepts an instance id MUST do so).
#[tauri::command]
#[specta::specta]
pub async fn instance_down(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    if !is_valid_instance_id(&id) {
        return Err(AppError::bad_request(format!("invalid instance id: {id}")));
    }
    down(&state.engine, &id, None).await?;
    Ok(())
}

/// Stop + remove the container, the per-instance built image, and (by default) the
/// per-instance DATA VOLUMES; then the definition. A load of the (best-effort)
/// definition precedes removal so the image tag + volume names are known; a missing
/// definition still gets its dir removed.
#[tauri::command]
#[specta::specta]
pub async fn instance_delete(
    state: State<'_, AppState>,
    id: String,
    opts: DeleteOpts,
) -> Result<DeleteView, AppError> {
    if !is_valid_instance_id(&id) {
        return Err(AppError::bad_request(format!("invalid instance id: {id}")));
    }
    let instance = load_instance(&format!("{}/{}", state.store, id)).ok();
    down(&state.engine, &id, None).await?;
    if let Some(inst) = &instance {
        remove_instance_image(&state.engine, inst).await?;
    }

    let mut warnings: Vec<String> = Vec::new();
    match &instance {
        Some(inst) => {
            let data = remove_instance_data(
                &state.engine,
                inst,
                RemoveDataOpts {
                    volumes: opts.volumes,
                    bind_data: opts.bind_data,
                    data_root: None,
                },
            )
            .await?;
            if !data.volumes_failed.is_empty() {
                // Keep the definition: without it the volume names can't be
                // re-derived for a retry (they would become invisible orphans).
                let failed = data
                    .volumes_failed
                    .iter()
                    .map(|f| format!("{}: {}", f.name, f.error))
                    .collect::<Vec<_>>()
                    .join("; ");
                return Err(AppError::internal(format!(
                    "data volumes not removed ({failed}) — instance kept, retry delete"
                )));
            }
            if let Some(bind) = &data.bind_dir_failed {
                // The volumes are already gone (irreversible) — disclose the partial
                // outcome rather than pretend it fully worked or fully didn't.
                warnings.push(format!(
                    "host data NOT removed ({}) — remove manually: {}",
                    bind.error, bind.path
                ));
            }
        }
        None => {
            warnings.push(
                "definition was unreadable — its image and data volumes (if any) were NOT removed"
                    .to_string(),
            );
        }
    }

    remove_instance_dir(&state.store, &id)?;
    Ok(DeleteView {
        warning: (!warnings.is_empty()).then(|| warnings.join("; ")),
    })
}

/// Derive a fresh instance from an existing one (copies the bundle + Settings
/// override minus ports; data starts empty), deconflict its DEFINED ports, and
/// return the finished view + bumps.
#[tauri::command]
#[specta::specta]
pub async fn instance_duplicate(
    state: State<'_, AppState>,
    id: String,
) -> Result<ImportView, AppError> {
    let instance = load_by_id(&state.store, &id)?;
    let store = state.store.clone();
    let source = instance.instance_id.clone();
    let dup = tokio::task::spawn_blocking(move || duplicate_instance(&store, &source))
        .await
        .map_err(|e| AppError::internal(format!("duplicate task failed: {e}")))??;
    let bumps = deconflict_host_ports(&state.store, &dup)?;
    let over = load_instance_config(&dup.dir)?; // re-read → reflects the bumps
    Ok(ImportView {
        view: to_instance_view(&dup, &over),
        bumps,
    })
}

/// The Settings view-model for an instance: each manifest port/env/mount with its
/// author default + saved override, plus the host ports DEFINED by OTHER instances
/// and whether a restart is needed.
#[tauri::command]
#[specta::specta]
pub async fn get_config(
    state: State<'_, AppState>,
    id: String,
) -> Result<InstanceSettings, AppError> {
    let instance = load_by_id(&state.store, &id)?;
    let over = load_instance_config(&instance.dir)?;
    let taken = defined_host_ports(&state.store, Some(&instance.instance_id))?;
    let restart = restart_needed(&instance, &over)?;
    Ok(build_settings(&instance, &over, taken, restart))
}

/// Validate an override (value ranges + keys must name manifest items) and persist
/// it to `config.yaml`; it takes effect on the next `up`.
#[tauri::command]
#[specta::specta]
pub async fn set_config(
    state: State<'_, AppState>,
    id: String,
    over: Override,
) -> Result<SetConfigView, AppError> {
    let instance = load_by_id(&state.store, &id)?;
    // The override arrives already-deserialized (serde), bypassing parse_override's
    // value validation — run it explicitly, then check the keys against the manifest.
    validate_override(&over)?;
    assert_known_keys(&instance, &over)?;
    save_instance_config(&instance.dir, &over)?;
    Ok(SetConfigView {
        restart_needed: restart_needed(&instance, &over)?,
    })
}

/// Set or clear the per-instance display name (`meta.name`). `None` — or a name
/// that trims to empty / equals the manifest brand — clears the override, so the
/// display returns to tracking the manifest name. Core re-validates the id at the
/// path-touching sink; the row list reflects the change on the next fetch.
#[tauri::command]
#[specta::specta]
pub async fn rename_instance(
    state: State<'_, AppState>,
    id: String,
    name: Option<String>,
) -> Result<(), AppError> {
    if !is_valid_instance_id(&id) {
        return Err(AppError::bad_request(format!("invalid instance id: {id}")));
    }
    let store = state.store.clone();
    tokio::task::spawn_blocking(move || set_instance_name(&store, &id, name))
        .await
        .map_err(|e| AppError::internal(format!("rename task failed: {e}")))??;
    Ok(())
}

/// Stage an in-place update for a GitHub-sourced instance: re-fetch its recorded
/// spec (optionally overriding the ref; empty ⇒ default branch) into the
/// instance's pending-update staging, and return the preview for the re-trust
/// gate. Nothing live changes until `update_commit`.
#[tauri::command]
#[specta::specta]
pub async fn update_prepare(
    state: State<'_, AppState>,
    id: String,
    new_ref: Option<String>,
) -> Result<UpdatePreview, AppError> {
    if !is_valid_instance_id(&id) {
        return Err(AppError::bad_request(format!("invalid instance id: {id}")));
    }
    let store = state.store.clone();
    let preview =
        tokio::task::spawn_blocking(move || prepare_update(&store, &id, new_ref.as_deref()))
            .await
            .map_err(|e| AppError::internal(format!("update task failed: {e}")))??;
    Ok(preview)
}

/// Apply a prepared update (the user trusted it): swap the bundle, stop the
/// container still running the OLD code, and reclaim the superseded image tag
/// when the version changed. The client rebuilds next via `instance_install`
/// (streamed) and refetches the rows.
#[tauri::command]
#[specta::specta]
pub async fn update_commit(
    state: State<'_, AppState>,
    id: String,
) -> Result<InstanceView, AppError> {
    let old = load_by_id(&state.store, &id)?;
    let old_version = old.manifest.version.clone();
    let store = state.store.clone();
    let commit_id = id.clone();
    let updated = tokio::task::spawn_blocking(move || commit_update(&store, &commit_id))
        .await
        .map_err(|e| AppError::internal(format!("update task failed: {e}")))??;
    // The bundle is swapped — a still-running container executes retired code, so
    // stop it as part of the update (the flow rebuilds + restarts right after).
    down(&state.engine, &id, None).await?;
    remove_superseded_image(&state.engine, &updated, &old_version).await?;
    let over = load_instance_config(&updated.dir)?;
    Ok(to_instance_view(&updated, &over))
}

/// Drop a prepared update (the user declined the re-trust gate). The instance is
/// untouched; idempotent.
#[tauri::command]
#[specta::specta]
pub async fn update_discard(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    if !is_valid_instance_id(&id) {
        return Err(AppError::bad_request(format!("invalid instance id: {id}")));
    }
    let store = state.store.clone();
    tokio::task::spawn_blocking(move || discard_update(&store, &id))
        .await
        .map_err(|e| AppError::internal(format!("update task failed: {e}")))??;
    Ok(())
}

/// Import a recipe bundle from a local path (a tar / tar.gz archive file or a
/// directory) into a new instance, then deconflict its host ports. The frontend
/// picks the path via the dialog plugin.
#[tauri::command]
#[specta::specta]
pub async fn import_recipe(
    state: State<'_, AppState>,
    source: String,
) -> Result<ImportView, AppError> {
    let metadata = std::fs::metadata(&source)
        .map_err(|_| AppError::bad_request(format!("not found: {source}")))?;
    let store = state.store.clone();
    let is_dir = metadata.is_dir();
    let path = source.clone();
    let instance = tokio::task::spawn_blocking(move || ingest_path(&path, &store, is_dir))
        .await
        .map_err(|e| AppError::internal(format!("import task failed: {e}")))??;
    finalize_import(&state, instance)
}

/// Import a recipe from a GitHub source spec (`owner/repo[/subdir][@ref]`, optional
/// `github:` prefix), download + ingest it, then deconflict. Public repos only.
#[tauri::command]
#[specta::specta]
pub async fn import_github(
    state: State<'_, AppState>,
    spec: String,
) -> Result<ImportView, AppError> {
    let spec = spec.trim().to_string();
    if spec.is_empty() {
        return Err(AppError::bad_request("missing GitHub spec"));
    }
    let store = state.store.clone();
    let instance = tokio::task::spawn_blocking(move || {
        ingest_github(&spec, &store, GithubIngestOpts::default())
    })
    .await
    .map_err(|e| AppError::internal(format!("import task failed: {e}")))??;
    finalize_import(&state, instance)
}

/// Export one persisted mount's data as a tar written to `dest` (the frontend picks
/// `dest` via the dialog plugin). Works on a stopped instance (a throwaway helper
/// reads the data).
#[tauri::command]
#[specta::specta]
pub async fn export_mount(
    state: State<'_, AppState>,
    id: String,
    mount: String,
    dest: String,
) -> Result<(), AppError> {
    let instance = load_by_id(&state.store, &id)?;
    if !instance.manifest.mounts.iter().any(|mt| mt.name == mount) {
        let names = if instance.manifest.mounts.is_empty() {
            "(none)".to_string()
        } else {
            instance
                .manifest
                .mounts
                .iter()
                .map(|mt| mt.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        };
        return Err(AppError::bad_request(format!(
            "unknown mount \"{mount}\" — available: {names}"
        )));
    }

    let mut stream = core_export_mount(&state.engine, &instance, &mount).await?;
    // Stream chunks straight to the file. On any transport or I/O error, remove the
    // partial file so a truncated .tar never lingers looking like a good export.
    let write: Result<(), AppError> = async {
        let file = std::fs::File::create(&dest)?;
        let mut writer = std::io::BufWriter::new(file);
        while let Some(chunk) = stream.next().await {
            writer.write_all(&chunk?)?;
        }
        writer.flush()?;
        Ok(())
    }
    .await;
    if write.is_err() {
        let _ = std::fs::remove_file(&dest);
    }
    write
}

/// Open a LOCAL web-service URL in the OS default browser via the opener plugin.
/// Locked down: only http(s) localhost URLs, passed as a direct arg (the plugin
/// never shells out), so neither command injection nor an arbitrary opener
/// (file://, app protocols, remote hosts) is possible.
#[tauri::command]
#[specta::specta]
pub async fn open_service_url(app: tauri::AppHandle, url: String) -> Result<(), AppError> {
    if !is_local_service_url(&url) {
        return Err(AppError::bad_request(
            "only local http(s) service URLs can be opened",
        ));
    }
    app.opener()
        .open_url(url, None::<String>)
        .map_err(|e| AppError::internal(e.to_string()))
}

// --- private helpers ------------------------------------------------------

/// Ingest a directory or an archive file (blocking — runs under `spawn_blocking`).
fn ingest_path(source: &str, store: &str, is_dir: bool) -> Result<Instance, compositz_core::Error> {
    if is_dir {
        ingest_bundle(
            BundleSource::Dir {
                dir: source.to_string(),
            },
            store,
            IngestOpts {
                source: Some(format!("dir:{source}")),
                ..Default::default()
            },
        )
    } else {
        // Stream the file through extraction (never buffer it whole in RAM).
        let file = std::fs::File::open(source)?;
        ingest_bundle(
            BundleSource::Archive {
                reader: Box::new(file),
                subdir: None,
            },
            store,
            IngestOpts {
                source: Some(format!("file:{source}")),
                ..Default::default()
            },
        )
    }
}

/// Deconflict a freshly-created instance's host ports (persisting any reassignment)
/// and build its view AFTER, so it reflects the assigned ports. The single import
/// finalize shared by file + GitHub import, so the view shape cannot drift between
/// them.
fn finalize_import(state: &AppState, instance: Instance) -> Result<ImportView, AppError> {
    let bumps = deconflict_host_ports(&state.store, &instance)?;
    let over = load_instance_config(&instance.dir)?; // re-reads config.yaml → reflects bumps
    Ok(ImportView {
        view: to_instance_view(&instance, &over),
        bumps,
    })
}

/// Only a local web-service URL may be opened (the dashboard's services are all
/// localhost). Rejects any non-http(s) scheme or non-loopback host.
fn is_local_service_url(raw: &str) -> bool {
    let Ok(parsed) = url::Url::parse(raw) else {
        return false;
    };
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return false;
    }
    matches!(
        parsed.host_str(),
        Some("localhost" | "127.0.0.1" | "::1" | "[::1]")
    )
}
