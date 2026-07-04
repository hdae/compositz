//! The recipe domain — the `compositz.yaml` manifest, the instance store,
//! per-install config, ingestion, run spec, and lifecycle operations.

pub mod config;
pub mod github;
pub mod ingest;
pub mod instance;
pub mod loader;
pub mod manifest;
pub mod operations;
pub mod run;
pub mod update;

/// Normalize a directory path to forward-slash separators with no trailing slash.
/// Instance ids are the last path segment, and the build
/// context walk derives relative paths, so both need one canonical shape.
pub(crate) fn norm_dir(dir: &str) -> String {
    dir.replace('\\', "/").trim_end_matches('/').to_string()
}
