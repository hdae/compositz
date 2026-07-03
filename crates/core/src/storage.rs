//! Where Compositz keeps host-side state, and how host paths are derived.
//!
//! Ported from `packages/core/src/storage.ts`. Instance-centric (ADR-017):
//!   - app-data:  the instance store (`instances/<instanceId>/`) + settings.
//!   - data-root: per-instance host-VISIBLE data (bind mounts); user-configurable.
//!   - volumes:   Docker-managed named volumes (everything else; named via brand).
//!
//! Path DERIVATION is pure ([`bind_host_path`] takes the data-root as input). The
//! per-OS DEFAULT locations are the only impure part — they read the environment,
//! injectable via [`Platform`] so they stay unit-testable.

use std::path::PathBuf;

use crate::Error;
use crate::brand::BRAND_NAME;

/// The host environment the default-location resolvers read. A trait (rather than
/// reading `std::env` directly) so tests inject a fake OS + vars without touching
/// the real process environment.
pub trait Platform {
    /// The OS family, matching `std::env::consts::OS` values (`"windows"`, …).
    fn os(&self) -> &str;
    /// An environment variable's value, if set.
    fn env(&self, key: &str) -> Option<String>;
}

/// The real host: `std::env::consts::OS` + the process environment.
pub struct HostPlatform;

impl Platform for HostPlatform {
    fn os(&self) -> &str {
        std::env::consts::OS
    }

    fn env(&self, key: &str) -> Option<String> {
        std::env::var(key).ok()
    }
}

/// Join path components with the runtime separator, mirroring the Deno
/// `@std/path` `join`. Core tests run on Linux, so the separator is `/`; the
/// injected `Platform.os` only steers which env branch is taken, never the
/// separator (identical to the Deno source).
fn path_join(parts: &[&str]) -> String {
    let mut path = PathBuf::new();
    for part in parts {
        path.push(part);
    }
    path.to_string_lossy().into_owned()
}

/// Host directory for a bind mount: `<data-root>/<instanceId>/<name>`.
/// Host-browsable, so the layout is derived from the instance id + mount name
/// (never an author-written absolute path). NOTE: the path is on the Docker
/// daemon's host — correct for a local daemon; a remote `DOCKER_HOST` resolves
/// it on that host.
pub fn bind_host_path(data_root: &str, instance_id: &str, mount_name: &str) -> String {
    path_join(&[data_root, instance_id, mount_name])
}

/// The instance store: `<app-data>/instances`. Holds one self-contained directory
/// per instance. Overridable via `COMPOSITZ_INSTANCES_DIR` (tests / dev).
/// Absolute — independent of the cwd.
pub fn instances_dir(p: &impl Platform) -> Result<String, Error> {
    if let Some(dir) = p.env("COMPOSITZ_INSTANCES_DIR") {
        return Ok(dir);
    }
    Ok(path_join(&[&app_data_dir(p)?, "instances"]))
}

/// App-data directory (instance store / settings):
/// `%APPDATA%\compositz` on Windows, else `$XDG_DATA_HOME/compositz` or
/// `$HOME/.local/share/compositz`.
pub fn app_data_dir(p: &impl Platform) -> Result<String, Error> {
    if p.os() == "windows" {
        if let Some(app_data) = p.env("APPDATA") {
            return Ok(path_join(&[&app_data, BRAND_NAME]));
        }
        return Ok(path_join(&[&home(p)?, "AppData", "Roaming", BRAND_NAME]));
    }
    if let Some(xdg) = p.env("XDG_DATA_HOME") {
        return Ok(path_join(&[&xdg, BRAND_NAME]));
    }
    Ok(path_join(&[&home(p)?, ".local", "share", BRAND_NAME]))
}

/// Default host data-root for bind mounts: `%USERPROFILE%\Compositz` on Windows,
/// else `$HOME/Compositz`. User-overridable per install.
pub fn default_data_root(p: &impl Platform) -> Result<String, Error> {
    // The directory is user-facing (they browse outputs here), so capitalize it.
    let dir_name = capitalize(BRAND_NAME);
    Ok(path_join(&[&home(p)?, &dir_name]))
}

fn home(p: &impl Platform) -> Result<String, Error> {
    let var = if p.os() == "windows" {
        "USERPROFILE"
    } else {
        "HOME"
    };
    p.env(var)
        .ok_or_else(|| Error::HomeDirUnresolved(var.to_string()))
}

/// Uppercase the first character (`compositz` => `Compositz`).
fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}
