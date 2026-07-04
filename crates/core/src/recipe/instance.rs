//! The instance: the self-contained, deployed unit (ADR-017). It owns everything
//! keyed by its `instanceId` — the embedded bundle (`app/`), provenance
//! (`meta.json`), and (RI-4) the per-install override. A recipe has NO separate
//! store; it is just the bundle copied inside an instance.
//!
//!   <instancesDir>/<instanceId>/
//!     app/            ← the recipe bundle (manifest + Dockerfile + context)
//!     meta.json       ← { source, createdAt }  (instanceId == the directory name)
//!     config.yaml     ← per-instance override (RI-4)
//!
//! Two hardening notes: the destructive [`remove_instance_dir`] validates the
//! id ITSELF (ADR-025 — a path-shaped id must never become a recursive delete of
//! the whole store), and the config/meta writes are ATOMIC (temp file + fsync +
//! rename), structurally closing the non-atomic-write known issue.

use std::io::Write;
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::Error;
use crate::build::BuildFile;
use crate::recipe::config::{Override, parse_override, serialize_override};
use crate::recipe::loader::load_recipe;
use crate::recipe::manifest::Manifest;
use crate::recipe::norm_dir;

/// The instance id charset — `<appId>-<rand>`, lowercase alphanumeric + hyphen.
/// Callers that accept an id from outside MUST validate against this, since it
/// flows into filesystem paths and Docker names — and [`remove_instance_dir`]
/// enforces it itself, so no caller can turn a path-shaped "id" (`.`, `..`,
/// `a/b`) into a recursive delete outside one instance directory.
static INSTANCE_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-z0-9][a-z0-9-]{0,80}$").unwrap());

/// Subdirectory holding the recipe bundle inside an instance directory.
pub const APP_SUBDIR: &str = "app";
/// Provenance file inside an instance directory.
pub const META_FILE: &str = "meta.json";
/// Per-instance launch override (RI-4) inside an instance directory.
pub const CONFIG_FILE: &str = "config.yaml";
/// Snapshot of the override the instance was last LAUNCHED with (written at `up`)
/// — lets the UI tell when the saved config has diverged from what's running.
pub const LAUNCHED_FILE: &str = ".launched.yaml";

/// Whether an id from outside is a legal instance id (see [`INSTANCE_ID`]).
pub fn is_valid_instance_id(id: &str) -> bool {
    INSTANCE_ID.is_match(id)
}

/// Non-derivable provenance for an instance (the manifest holds appId + version).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceMeta {
    /// Where the bundle came from, e.g. `upload`, `dir:…`, `github:owner/repo@ref`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// ISO-8601 creation time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    /// Per-instance display-name override. Absent for a fresh import (the manifest
    /// brand name is shown); a duplicate sets it to `"<name> (copy)"` so two
    /// deployments of the same recipe are distinguishable at a glance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// A deployed instance: its id, the app it runs, the embedded bundle, provenance.
#[derive(Debug, Clone)]
pub struct Instance {
    /// The single runtime key — container/image/volume/data all derive from it.
    pub instance_id: String,
    /// The app (manifest id) this instance runs — a non-unique slug.
    pub app_id: String,
    /// Instance directory: `<instancesDir>/<instanceId>`. Forward-slash normalized.
    pub dir: String,
    pub manifest: Manifest,
    /// Build-context files (excludes the manifest), from the embedded bundle.
    pub context: Vec<BuildFile>,
    pub meta: InstanceMeta,
}

impl Instance {
    /// The name shown to the user: the per-instance override if set, else the
    /// manifest brand name. The ONE derivation — display (`to_instance_view`)
    /// and ordering (`list_instances`) MUST both go through it, or a renamed
    /// duplicate sorts under a name the user never sees.
    pub fn display_name(&self) -> &str {
        self.meta.name.as_deref().unwrap_or(&self.manifest.name)
    }
}

/// Load one instance from its directory (reads the embedded bundle + provenance).
pub fn load_instance(instance_dir: &str) -> Result<Instance, Error> {
    let dir = norm_dir(instance_dir);
    let instance_id = dir.rsplit('/').next().unwrap_or("").to_string();
    // The derived id keys every Docker resource name; a dir that violates the id
    // charset MUST fail loud here (same self-defense as `remove_instance_dir`),
    // not surface an instance whose actions would all be rejected downstream.
    if !is_valid_instance_id(&instance_id) {
        return Err(Error::Instance(format!(
            "invalid instance directory: {instance_dir}"
        )));
    }
    let bundle = load_recipe(&format!("{dir}/{APP_SUBDIR}"))?;
    let meta = read_meta(&format!("{dir}/{META_FILE}"));
    Ok(Instance {
        instance_id,
        app_id: bundle.manifest.id.clone(),
        dir,
        manifest: bundle.manifest,
        context: bundle.context,
        meta,
    })
}

/// Load every valid instance under the store (skips invalid ones). Sorted by name.
pub fn list_instances(instances_dir: &str) -> Vec<Instance> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(instances_dir) else {
        return out; // store dir missing yet — no instances
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue; // skip staging dirs
        }
        // `file_type()` is `lstat`-based (does NOT follow symlinks), like the
        // loader's own walk — a symlinked entry is not treated as an instance
        // directory.
        if !entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
            continue;
        }
        // Skip directories without a valid embedded bundle.
        if let Ok(instance) = load_instance(&format!("{instances_dir}/{name}")) {
            out.push(instance);
        }
    }
    // Case-insensitive by the effective display name — the same key the UI
    // renders, so a duplicate named "Hello (copy)" sorts under that, not under
    // its manifest brand.
    out.sort_by(|a, b| {
        a.display_name()
            .to_lowercase()
            .cmp(&b.display_name().to_lowercase())
    });
    out
}

/// Remove an instance's directory (its definition + override). Docker resources /
/// data are untouched. The id is validated HERE (not only at the callers): a
/// path-shaped id (`.`, `..`, `a/b`) would otherwise recursively delete the whole
/// store or app-data dir. A missing dir is fine (idempotent); any other failure
/// is surfaced (fail loud — a swallowed error would report "removed" for a
/// still-present definition).
pub fn remove_instance_dir(instances_dir: &str, instance_id: &str) -> Result<(), Error> {
    if !is_valid_instance_id(instance_id) {
        return Err(Error::Instance(format!(
            "invalid instance id: \"{instance_id}\""
        )));
    }
    match std::fs::remove_dir_all(format!("{instances_dir}/{instance_id}")) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(Error::Io(e)),
    }
}

/// Load the per-instance launch override (`config.yaml`). An absent file ⇒ the
/// empty override (the common case). A present-but-invalid file is surfaced (fail
/// loud — never silently launch with a misread override).
pub fn load_instance_config(instance_dir: &str) -> Result<Override, Error> {
    Ok(read_override_file(instance_dir, CONFIG_FILE)?.unwrap_or_default())
}

/// Persist the per-instance launch override (`config.yaml`), atomically.
pub fn save_instance_config(instance_dir: &str, overrides: &Override) -> Result<(), Error> {
    let path = format!("{}/{}", norm_dir(instance_dir), CONFIG_FILE);
    atomic_write(Path::new(&path), serialize_override(overrides)?.as_bytes())
}

/// Load the override the instance was last LAUNCHED with (`.launched.yaml`).
/// `None` if it was never launched. Compared against the live `config.yaml` to
/// tell whether a restart is needed to apply edited settings.
pub fn load_launched_config(instance_dir: &str) -> Result<Option<Override>, Error> {
    read_override_file(instance_dir, LAUNCHED_FILE)
}

/// Record the override an instance is launched with (written by `up`), atomically.
pub fn save_launched_config(instance_dir: &str, overrides: &Override) -> Result<(), Error> {
    let path = format!("{}/{}", norm_dir(instance_dir), LAUNCHED_FILE);
    atomic_write(Path::new(&path), serialize_override(overrides)?.as_bytes())
}

/// Write instance provenance (`meta.json`), atomically.
pub fn write_meta(path: &str, meta: &InstanceMeta) -> Result<(), Error> {
    let mut json = serde_json::to_string_pretty(meta)
        .map_err(|e| Error::Instance(format!("meta failed to serialize: {e}")))?;
    json.push('\n');
    atomic_write(Path::new(path), json.as_bytes())
}

/// Read + parse an override file under an instance dir; `None` if it doesn't exist.
fn read_override_file(instance_dir: &str, file: &str) -> Result<Option<Override>, Error> {
    let path = format!("{}/{}", norm_dir(instance_dir), file);
    match std::fs::read_to_string(&path) {
        // A present-but-invalid file throws (fail loud).
        Ok(text) => Ok(Some(parse_override(&text)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(Error::Io(e)),
    }
}

/// Read provenance; an empty meta on any error (missing / corrupt) — provenance
/// is best-effort and never blocks loading an instance.
fn read_meta(path: &str) -> InstanceMeta {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Write `contents` to `path` atomically: a temp file in the SAME directory,
/// fsynced, then renamed over the target. Same-directory guarantees the rename
/// is atomic (one filesystem), so a reader never sees a half-written file.
fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), Error> {
    let dir = path.parent().ok_or_else(|| {
        Error::Instance(format!("path has no parent directory: {}", path.display()))
    })?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    tmp.write_all(contents)?;
    tmp.as_file().sync_all()?;
    tmp.persist(path).map_err(|e| Error::Io(e.error))?;
    Ok(())
}
