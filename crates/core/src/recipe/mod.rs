//! The recipe domain — the `compositz.yaml` manifest and (in later migration
//! sub-steps) the instance store, per-install config, ingestion, run spec, and
//! lifecycle operations ported from `packages/core/src/recipe/`.

pub mod config;
pub mod instance;
pub mod loader;
pub mod manifest;

/// Normalize a directory path the way the Deno tree did: forward-slash separators
/// with no trailing slash. Instance ids are the last path segment, and the build
/// context walk derives relative paths, so both need one canonical shape.
pub(crate) fn norm_dir(dir: &str) -> String {
    dir.replace('\\', "/").trim_end_matches('/').to_string()
}
