//! In-place instance update: re-ingest a (new) ref of the SAME app into an
//! existing instance — the instance id, Docker volumes, and `config.yaml` all
//! survive, only the embedded bundle (`app/`) is replaced.
//!
//! Two-phase by design, because new code = new trust (the ADR-020 gate applies
//! to an update exactly as to a fresh import):
//!
//!   prepare  → download + extract into `<instance>/.update/` and return a
//!              preview (never touches `app/`), so the UI can ask for trust
//!   commit   → swap `app/` with the staged bundle and update provenance
//!   discard  → drop the staging (the instance is untouched)
//!
//! v1 updates GitHub-sourced instances only: `meta.source` round-trips through
//! the spec grammar, so the origin is recoverable. `file:` / `dir:` / `upload` /
//! `duplicate:` provenance has no re-fetchable origin (re-import instead).
//!
//! The staged bundle is REVALIDATED at commit (manifest parses, same `appId`) —
//! prepare-time checks are not trusted across the gap, a stale or tampered
//! staging must fail loud, never swap in.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tempfile::Builder;

use crate::Error;
use crate::recipe::github::{github_source, open_github_tarball, parse_github_spec, validate_ref};
use crate::recipe::ingest::{
    BundleSource, copy_tree_to, extract_archive_to, locate_bundle_root, now_iso8601,
};
use crate::recipe::instance::{
    APP_SUBDIR, Instance, InstanceMeta, META_FILE, OLD_APP_SUBDIR, is_valid_instance_id,
    load_instance, write_meta,
};
use crate::recipe::loader::load_recipe;
use crate::recipe::norm_dir;

/// Staging directory for a prepared (not yet trusted) update, inside the
/// instance directory. Dot-prefixed so nothing lists it; one pending update per
/// instance — a new prepare replaces it.
pub const UPDATE_SUBDIR: &str = ".update";
/// The staged provenance (`{ "source": … }`) next to the staged bundle.
const UPDATE_SOURCE_FILE: &str = "source.json";

/// The provenance recorded alongside a staged bundle, applied at commit. The
/// `version` pins WHAT the trust preview showed: commit re-reads the staged
/// manifest and refuses a mismatch, so the trust answer is bound to the staged
/// content, not merely to the instance.
#[derive(Debug, Serialize, Deserialize)]
struct StagedSource {
    source: String,
    version: String,
}

/// What a prepared update would do — the trust prompt's content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct UpdatePreview {
    pub instance_id: String,
    /// The provenance the update will record (`github:owner/repo[/subdir][@ref]`).
    pub source: String,
    pub current_version: String,
    pub new_version: String,
    pub new_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_description: Option<String>,
}

/// Prepare an update for a GitHub-sourced instance: re-fetch its recorded spec —
/// with `new_ref` overriding the ref when given (empty ⇒ the default branch) —
/// and stage the bundle for the trust gate. Blocking (network + extraction);
/// async callers wrap it in `spawn_blocking`.
pub fn prepare_update(
    instances_dir: &str,
    instance_id: &str,
    new_ref: Option<&str>,
) -> Result<UpdatePreview, Error> {
    let instance = load_validated(instances_dir, instance_id)?;
    let source = instance.meta.source.clone().ok_or_else(|| {
        Error::Recipe(
            "this instance has no recorded source — it cannot be updated in place".to_string(),
        )
    })?;
    if !source.starts_with("github:") {
        return Err(Error::Recipe(format!(
            "only GitHub-sourced instances can be updated in place (source: {source})"
        )));
    }
    let mut spec = parse_github_spec(&source)?;
    if let Some(raw) = new_ref {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            spec.git_ref = None; // explicit empty ⇒ the repo's default branch
        } else {
            validate_ref(trimmed, raw)?;
            spec.git_ref = Some(trimmed.to_string());
        }
    }

    let reader = open_github_tarball(&spec)?;
    stage_update_bundle(
        instances_dir,
        instance_id,
        BundleSource::Archive {
            reader,
            subdir: spec.subdir.clone(),
        },
        github_source(&spec),
    )
}

/// Stage a bundle as this instance's pending update (the source-agnostic half of
/// [`prepare_update`], and the seam its tests drive without a network). Extracts
/// into a temp dir inside the instance directory, validates the manifest, refuses
/// an app change, then publishes the staging as `<instance>/.update/` with one
/// rename (replacing any prior pending update).
pub fn stage_update_bundle(
    instances_dir: &str,
    instance_id: &str,
    source: BundleSource,
    source_label: String,
) -> Result<UpdatePreview, Error> {
    let instance = load_validated(instances_dir, instance_id)?;
    let instance_dir = PathBuf::from(&instance.dir);

    // Extract into RAII-cleaned staging INSIDE the instance dir (same filesystem,
    // so the publish below is an atomic rename).
    let staging = Builder::new()
        .prefix(".updstage-")
        .tempdir_in(&instance_dir)?;
    let subdir = match &source {
        BundleSource::Archive { subdir, .. } => subdir.clone(),
        BundleSource::Dir { .. } => None,
    };
    match source {
        BundleSource::Archive { reader, .. } => extract_archive_to(reader, staging.path())?,
        BundleSource::Dir { dir } => copy_tree_to(Path::new(&dir), staging.path())?,
    }

    let bundle_root = locate_bundle_root(staging.path(), subdir.as_deref())?;
    let manifest = load_recipe(bundle_root.to_str().ok_or_else(non_utf8)?)?.manifest;
    // An update must stay the SAME app: the instance id, image tag, and volume
    // names all embed the identity minted at import — a different app under the
    // same id would silently point them at foreign data.
    if manifest.id != instance.app_id {
        return Err(Error::Recipe(format!(
            "update changes the app: \"{}\" → \"{}\" — import it as a new instance instead",
            instance.app_id, manifest.id
        )));
    }

    // Assemble the complete staging (app/ + source.json) in a temp dir, then
    // publish it as `.update` with one rename — a pending update is either whole
    // or absent, never half-written.
    let publish = Builder::new()
        .prefix(".updpub-")
        .tempdir_in(&instance_dir)?;
    fs::rename(&bundle_root, publish.path().join(APP_SUBDIR))?;
    let staged = StagedSource {
        source: source_label,
        version: manifest.version.clone(),
    };
    let json = serde_json::to_string_pretty(&staged)
        .map_err(|e| Error::Instance(format!("staged source failed to serialize: {e}")))?;
    fs::write(publish.path().join(UPDATE_SOURCE_FILE), json)?;

    // Move any prior pending update ASIDE before deleting it: `remove_dir_all`
    // can fail half-way (a locked file — realistic under Windows AV), and a
    // half-deleted dir must never sit AT the pending path where a later commit
    // could read it. The rename detaches it atomically; its actual removal is
    // then free to fail (RAII cleanup — dot-prefixed, reclaimed with the
    // instance at worst).
    let pending = instance_dir.join(UPDATE_SUBDIR);
    let trash = Builder::new()
        .prefix(".updtrash-")
        .tempdir_in(&instance_dir)?;
    match fs::rename(&pending, trash.path().join("pending")) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(Error::Io(e)),
    }
    fs::rename(publish.path(), &pending)?;

    Ok(UpdatePreview {
        instance_id: instance.instance_id.clone(),
        source: staged.source,
        current_version: instance.manifest.version.clone(),
        new_version: manifest.version.clone(),
        new_name: manifest.name.clone(),
        new_description: manifest.description.clone(),
    })
}

/// Commit a prepared update: swap `app/` with the staged bundle and record the
/// new provenance (`source` + `updatedAt`; `createdAt` and a rename override are
/// preserved). The staged bundle is revalidated first. If the swap's second
/// rename fails, the original `app/` is restored (best-effort rollback) — the
/// instance is never left without a bundle when the old one is still present.
pub fn commit_update(instances_dir: &str, instance_id: &str) -> Result<Instance, Error> {
    let instance = load_validated(instances_dir, instance_id)?;
    let instance_dir = PathBuf::from(&instance.dir);
    let pending = instance_dir.join(UPDATE_SUBDIR);
    let staged_app = pending.join(APP_SUBDIR);

    let staged_json = fs::read_to_string(pending.join(UPDATE_SOURCE_FILE))
        .map_err(|_| Error::Recipe("no prepared update to commit".to_string()))?;
    let staged: StagedSource = serde_json::from_str(&staged_json)
        .map_err(|e| Error::Recipe(format!("staged update is corrupt: {e}")))?;
    // A staging without its bundle is the residue of an interrupted commit —
    // drop it and say so, instead of a confusing "no manifest" error.
    if !staged_app.is_dir() {
        let _ = fs::remove_dir_all(&pending);
        return Err(Error::Recipe(
            "staged update is incomplete — prepare the update again".to_string(),
        ));
    }
    // Revalidate — never trust prepare-time checks across the gap.
    let manifest = load_recipe(staged_app.to_str().ok_or_else(non_utf8)?)?.manifest;
    if manifest.id != instance.app_id {
        return Err(Error::Recipe(format!(
            "staged update changes the app: \"{}\" → \"{}\" — discarding it is the only safe move",
            instance.app_id, manifest.id
        )));
    }
    // Bind the trust answer to the CONTENT the preview showed, not just the
    // instance: a staging replaced or altered since the preview must re-gate.
    if manifest.version != staged.version {
        return Err(Error::Recipe(format!(
            "staged update changed since the preview (v{} → v{}) — prepare the update again",
            staged.version, manifest.version
        )));
    }

    let app = instance_dir.join(APP_SUBDIR);
    let old = instance_dir.join(OLD_APP_SUBDIR);
    remove_dir_if_present(&old)?;
    fs::rename(&app, &old)?;
    if let Err(e) = fs::rename(&staged_app, &app) {
        // Roll the original back in; a failed rollback leaves `.old-app` on disk
        // for manual recovery — never silently delete the only bundle copy.
        let _ = fs::rename(&old, &app);
        return Err(Error::Io(e));
    }

    let meta = InstanceMeta {
        source: Some(staged.source),
        updated_at: Some(now_iso8601()),
        ..instance.meta
    };
    write_meta(
        instance_dir.join(META_FILE).to_str().ok_or_else(non_utf8)?,
        &meta,
    )?;

    // The swap is done — cleanup failures must not fail the update (the leftovers
    // are dot-prefixed, invisible to the loader, and removed with the instance).
    let _ = fs::remove_dir_all(&old);
    let _ = fs::remove_dir_all(&pending);

    load_instance(instance_dir.to_str().ok_or_else(non_utf8)?)
}

/// Drop a prepared update, if any (idempotent). The instance itself is untouched.
pub fn discard_update(instances_dir: &str, instance_id: &str) -> Result<(), Error> {
    if !is_valid_instance_id(instance_id) {
        return Err(Error::Instance(format!(
            "invalid instance id: \"{instance_id}\""
        )));
    }
    let pending = Path::new(&norm_dir(instances_dir))
        .join(instance_id)
        .join(UPDATE_SUBDIR);
    remove_dir_if_present(&pending)
}

/// Validate the id (path-touching sinks defend themselves, ADR-025) and load the
/// instance.
fn load_validated(instances_dir: &str, instance_id: &str) -> Result<Instance, Error> {
    if !is_valid_instance_id(instance_id) {
        return Err(Error::Instance(format!(
            "invalid instance id: \"{instance_id}\""
        )));
    }
    load_instance(&format!("{}/{}", norm_dir(instances_dir), instance_id))
}

fn remove_dir_if_present(dir: &Path) -> Result<(), Error> {
    match fs::remove_dir_all(dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(Error::Io(e)),
    }
}

fn non_utf8() -> Error {
    Error::Instance("instance path is not valid UTF-8".to_string())
}
