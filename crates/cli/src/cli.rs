//! Shared CLI helpers: the instance store location, boundary-validated instance
//! resolution, and the build-progress stream driver.
//!
//! The core lifecycle functions take a raw `&str` id, so every command that
//! accepts an instance id MUST validate it at this boundary before any core
//! function touches paths or runs a destructive engine op. [`resolve_instance`]
//! validates first; the direct-id commands (`down`) validate inline.

use std::io::Write;

use anyhow::{Context, Result};
use compositz_core::storage::{HostPlatform, instances_dir};
use compositz_core::{BuildProgress, Instance, is_valid_instance_id, load_instance};
use futures_util::{Stream, StreamExt};

/// The instance store this CLI reads/writes: `COMPOSITZ_INSTANCES_DIR` when set,
/// else the per-OS app-data location.
pub fn store_dir() -> Result<String> {
    instances_dir(&HostPlatform).context("resolve the instance store directory")
}

/// Resolve an instance by id from the store.
///
/// Validates the id at the boundary BEFORE it reaches any path/engine op,
/// then loads it — mapping a load failure to a friendly not-found message that
/// points at `compositz ls`.
pub fn resolve_instance(instance_id: &str) -> Result<Instance> {
    if !is_valid_instance_id(instance_id) {
        anyhow::bail!("invalid instance id: \"{instance_id}\"");
    }
    let store = store_dir()?;
    load_instance(&format!("{store}/{instance_id}")).map_err(|_| {
        anyhow::anyhow!("instance not found: \"{instance_id}\" (in {store}). Run `compositz ls`.")
    })
}

/// Drive an install/build progress stream to completion.
///
/// Writes each `stream` fragment to stdout as-is (Docker's build output already
/// carries its own newlines) with an immediate flush so progress shows live;
/// invokes `on_aux` with each terminal image id (install prints it; up ignores
/// it); and fails loudly on a build error — either a stream `Err` (bollard's usual
/// shape) or a non-empty `error` progress record — so a failed build is never
/// reported as success.
pub async fn drive_build<S>(mut stream: S, mut on_aux: impl FnMut(&str)) -> Result<()>
where
    S: Stream<Item = Result<BuildProgress, compositz_core::Error>> + Unpin,
{
    let mut stdout = std::io::stdout();
    while let Some(item) = stream.next().await {
        let progress = item?;
        if let Some(fragment) = &progress.stream {
            print!("{fragment}");
            stdout.flush().ok();
        }
        if let Some(id) = &progress.aux_id {
            on_aux(id);
        }
        if let Some(error) = &progress.error {
            anyhow::bail!("build failed: {error}");
        }
    }
    Ok(())
}

/// The leading `n` characters of an id, for compact display (`&id[..n]` panics on a
/// non-char-boundary; ids are ASCII so this is only a length clamp, but stay safe).
pub fn short(id: &str, n: usize) -> &str {
    &id[..id.len().min(n)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_instance_rejects_a_path_shaped_id_before_touching_the_store() {
        // The ★ boundary: a path-shaped "id" must fail on validation, never reach
        // `load_instance` (which would join it into a filesystem path).
        for bad in ["..", ".", "a/b", "a\\b", "", "UPPER", "has space"] {
            let err = resolve_instance(bad).unwrap_err().to_string();
            assert!(
                err.contains("invalid instance id"),
                "id {bad:?} should be rejected as invalid, got: {err}"
            );
        }
    }

    #[test]
    fn short_clamps_without_panicking_on_a_short_id() {
        assert_eq!(short("abcdef", 3), "abc");
        assert_eq!(short("ab", 12), "ab");
        assert_eq!(short("", 4), "");
    }
}
