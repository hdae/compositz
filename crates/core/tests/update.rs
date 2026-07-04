//! Behavior tests for the in-place update (prepare → trust → commit / discard).
//!
//! The staging/commit machinery is driven through `stage_update_bundle` with
//! local `Dir` bundles — the same path `prepare_update` takes after its GitHub
//! download, minus the network. The GitHub-only gating of `prepare_update` is
//! tested directly (it fails before any network I/O for non-GitHub sources).

use std::fs;
use std::path::Path;

use compositz_core::recipe::ingest::BundleSource;
use compositz_core::recipe::instance::{list_instances, load_instance, load_instance_config};
use compositz_core::recipe::update::{
    UPDATE_SUBDIR, commit_update, discard_update, prepare_update, stage_update_bundle,
};
use tempfile::TempDir;

fn manifest(id: &str, name: &str, version: &str) -> String {
    format!(
        "manifestVersion: 2\nid: {id}\nname: {name}\nversion: \"{version}\"\nbuild: {{ dockerfile: Dockerfile }}\ngpu: none\n"
    )
}

/// Lay down an instance dir with a bundle, provenance, and a saved override.
fn create_instance(store: &Path, instance_id: &str, app_id: &str, source: &str) {
    let dir = store.join(instance_id);
    let app = dir.join("app");
    fs::create_dir_all(&app).unwrap();
    fs::write(
        app.join("compositz.yaml"),
        manifest(app_id, "Hello", "0.1.0"),
    )
    .unwrap();
    fs::write(app.join("Dockerfile"), "FROM scratch\nRUN echo v1\n").unwrap();
    fs::write(
        dir.join("meta.json"),
        format!("{{\n  \"source\": \"{source}\",\n  \"createdAt\": \"2026-01-01T00:00:00Z\"\n}}\n"),
    )
    .unwrap();
    fs::write(dir.join("config.yaml"), "env:\n  TOKEN: keep-me\n").unwrap();
}

/// A new bundle version as an on-disk dir (the update payload).
fn new_bundle(id: &str, name: &str, version: &str) -> TempDir {
    let dir = TempDir::new().unwrap();
    fs::write(
        dir.path().join("compositz.yaml"),
        manifest(id, name, version),
    )
    .unwrap();
    fs::write(dir.path().join("Dockerfile"), "FROM scratch\nRUN echo v2\n").unwrap();
    dir
}

fn dir_source(bundle: &TempDir) -> BundleSource {
    BundleSource::Dir {
        dir: bundle.path().to_str().unwrap().to_string(),
    }
}

fn store_path(dir: &TempDir) -> &str {
    dir.path().to_str().unwrap()
}

#[test]
fn stage_then_commit_swaps_the_bundle_keeping_id_config_and_created_at() {
    let store = TempDir::new().unwrap();
    create_instance(store.path(), "hello-abc123", "hello", "github:owner/repo");
    let bundle = new_bundle("hello", "Hello v2", "0.2.0");

    let preview = stage_update_bundle(
        store_path(&store),
        "hello-abc123",
        dir_source(&bundle),
        "github:owner/repo@v2".to_string(),
    )
    .unwrap();
    assert_eq!(preview.current_version, "0.1.0");
    assert_eq!(preview.new_version, "0.2.0");
    assert_eq!(preview.new_name, "Hello v2");
    assert_eq!(preview.source, "github:owner/repo@v2");

    // Staged, not applied: the live bundle is still v1.
    let dir = store.path().join("hello-abc123");
    let before = load_instance(dir.to_str().unwrap()).unwrap();
    assert_eq!(before.manifest.version, "0.1.0");
    assert!(dir.join(UPDATE_SUBDIR).join("app").exists());

    let updated = commit_update(store_path(&store), "hello-abc123").unwrap();
    assert_eq!(updated.instance_id, "hello-abc123"); // the id survives
    assert_eq!(updated.manifest.version, "0.2.0");
    assert_eq!(updated.meta.source.as_deref(), Some("github:owner/repo@v2"));
    assert_eq!(
        updated.meta.created_at.as_deref(),
        Some("2026-01-01T00:00:00Z"), // the original import time is preserved
    );
    assert!(updated.meta.updated_at.is_some());
    // The per-instance override survives the bundle swap.
    let config = load_instance_config(dir.to_str().unwrap()).unwrap();
    assert_eq!(
        config.env.unwrap().get("TOKEN").map(String::as_str),
        Some("keep-me")
    );
    // Staging and swap scratch dirs are gone; the store lists exactly one instance.
    assert!(!dir.join(UPDATE_SUBDIR).exists());
    assert!(!dir.join(".old-app").exists());
    assert_eq!(list_instances(store_path(&store)).len(), 1);
}

#[test]
fn stage_rejects_an_app_change_and_commit_revalidates_a_tampered_staging() {
    let store = TempDir::new().unwrap();
    create_instance(store.path(), "hello-abc123", "hello", "github:owner/repo");

    // Prepare-time: a bundle for a DIFFERENT app must not stage.
    let other = new_bundle("other", "Other", "9.9.9");
    let err = stage_update_bundle(
        store_path(&store),
        "hello-abc123",
        dir_source(&other),
        "github:owner/other".to_string(),
    )
    .unwrap_err();
    assert!(err.to_string().contains("changes the app"), "got: {err}");
    assert!(
        !store
            .path()
            .join("hello-abc123")
            .join(UPDATE_SUBDIR)
            .exists()
    );

    // Commit-time: stage a valid update, then tamper the staged manifest — commit
    // must revalidate and refuse, leaving the live bundle untouched.
    let good = new_bundle("hello", "Hello", "0.2.0");
    stage_update_bundle(
        store_path(&store),
        "hello-abc123",
        dir_source(&good),
        "github:owner/repo".to_string(),
    )
    .unwrap();
    let staged_manifest = store
        .path()
        .join("hello-abc123")
        .join(UPDATE_SUBDIR)
        .join("app")
        .join("compositz.yaml");
    fs::write(&staged_manifest, manifest("other", "Other", "0.2.0")).unwrap();
    let err = commit_update(store_path(&store), "hello-abc123").unwrap_err();
    assert!(err.to_string().contains("changes the app"), "got: {err}");
    let live = load_instance(store.path().join("hello-abc123").to_str().unwrap()).unwrap();
    assert_eq!(live.manifest.version, "0.1.0");
}

#[test]
fn a_second_stage_replaces_the_pending_update() {
    let store = TempDir::new().unwrap();
    create_instance(store.path(), "hello-abc123", "hello", "github:owner/repo");

    let first = new_bundle("hello", "Hello", "0.2.0");
    let second = new_bundle("hello", "Hello", "0.3.0");
    for (bundle, label) in [
        (&first, "github:owner/repo@a"),
        (&second, "github:owner/repo@b"),
    ] {
        stage_update_bundle(
            store_path(&store),
            "hello-abc123",
            dir_source(bundle),
            label.to_string(),
        )
        .unwrap();
    }

    let updated = commit_update(store_path(&store), "hello-abc123").unwrap();
    assert_eq!(updated.manifest.version, "0.3.0"); // the LAST prepare wins
    assert_eq!(updated.meta.source.as_deref(), Some("github:owner/repo@b"));
}

#[test]
fn discard_drops_the_staging_and_commit_without_prepare_fails() {
    let store = TempDir::new().unwrap();
    create_instance(store.path(), "hello-abc123", "hello", "github:owner/repo");

    // Nothing staged: commit fails loud, discard is a quiet no-op.
    let err = commit_update(store_path(&store), "hello-abc123").unwrap_err();
    assert!(err.to_string().contains("no prepared update"), "got: {err}");
    discard_update(store_path(&store), "hello-abc123").unwrap();

    let bundle = new_bundle("hello", "Hello", "0.2.0");
    stage_update_bundle(
        store_path(&store),
        "hello-abc123",
        dir_source(&bundle),
        "github:owner/repo".to_string(),
    )
    .unwrap();
    discard_update(store_path(&store), "hello-abc123").unwrap();
    assert!(
        !store
            .path()
            .join("hello-abc123")
            .join(UPDATE_SUBDIR)
            .exists()
    );
    // The instance is untouched.
    let live = load_instance(store.path().join("hello-abc123").to_str().unwrap()).unwrap();
    assert_eq!(live.manifest.version, "0.1.0");
}

#[test]
fn prepare_update_gates_on_a_github_source_before_any_network() {
    let store = TempDir::new().unwrap();
    for (id, source, expected) in [
        ("filey-abc123", "file:C:/x.tar", "only GitHub-sourced"),
        ("dupey-abc123", "duplicate:hello-1", "only GitHub-sourced"),
        ("uploady-ab12", "upload", "only GitHub-sourced"),
    ] {
        create_instance(store.path(), id, "hello", source);
        let err = prepare_update(store_path(&store), id, None).unwrap_err();
        assert!(err.to_string().contains(expected), "{source} got: {err}");
    }

    // A malformed override ref fails validation before any download.
    create_instance(store.path(), "hubby-abc123", "hello", "github:owner/repo");
    let err = prepare_update(store_path(&store), "hubby-abc123", Some("bad ref")).unwrap_err();
    assert!(err.to_string().contains("bad ref"), "got: {err}");
}

#[test]
fn update_paths_reject_path_shaped_ids() {
    let store = TempDir::new().unwrap();
    create_instance(store.path(), "hello-abc123", "hello", "github:owner/repo");
    for evil in [".", "..", "a/b", "UPPER", ""] {
        assert!(prepare_update(store_path(&store), evil, None).is_err());
        assert!(commit_update(store_path(&store), evil).is_err());
        assert!(discard_update(store_path(&store), evil).is_err());
    }
    // The store is untouched.
    assert_eq!(list_instances(store_path(&store)).len(), 1);
}

// --- interrupted-commit recovery (fault injection) ---------------------------

#[test]
fn a_crash_between_the_swap_renames_self_heals_on_the_next_load() {
    let store = TempDir::new().unwrap();
    create_instance(store.path(), "hello-abc123", "hello", "github:owner/repo");
    let bundle = new_bundle("hello", "Hello", "0.2.0");
    stage_update_bundle(
        store_path(&store),
        "hello-abc123",
        dir_source(&bundle),
        "github:owner/repo".to_string(),
    )
    .unwrap();

    // Fault injection: reproduce the dead state a hard kill leaves between
    // commit's two renames — the original bundle parked at `.old-app`, no `app/`.
    let dir = store.path().join("hello-abc123");
    fs::rename(dir.join("app"), dir.join(".old-app")).unwrap();

    // The next load rolls the original back in (the commit never completed, so
    // pre-update IS the correct state) instead of silently skipping the instance.
    let healed = load_instance(dir.to_str().unwrap()).unwrap();
    assert_eq!(healed.manifest.version, "0.1.0");
    assert!(dir.join("app").is_dir());
    assert!(!dir.join(".old-app").exists());
    assert_eq!(list_instances(store_path(&store)).len(), 1);

    // The staging survived the interruption — the commit can simply be retried.
    let updated = commit_update(store_path(&store), "hello-abc123").unwrap();
    assert_eq!(updated.manifest.version, "0.2.0");
}

#[test]
fn commit_rejects_a_staging_whose_version_changed_since_the_preview() {
    let store = TempDir::new().unwrap();
    create_instance(store.path(), "hello-abc123", "hello", "github:owner/repo");
    let bundle = new_bundle("hello", "Hello", "0.2.0");
    stage_update_bundle(
        store_path(&store),
        "hello-abc123",
        dir_source(&bundle),
        "github:owner/repo".to_string(),
    )
    .unwrap();

    // Same app, different content than the preview showed — the trust answer
    // must not carry over.
    let staged_manifest = store
        .path()
        .join("hello-abc123")
        .join(UPDATE_SUBDIR)
        .join("app")
        .join("compositz.yaml");
    fs::write(&staged_manifest, manifest("hello", "Hello", "9.9.9")).unwrap();

    let err = commit_update(store_path(&store), "hello-abc123").unwrap_err();
    assert!(
        err.to_string().contains("changed since the preview"),
        "got: {err}"
    );
    let live = load_instance(store.path().join("hello-abc123").to_str().unwrap()).unwrap();
    assert_eq!(live.manifest.version, "0.1.0");
}

#[test]
fn commit_drops_an_incomplete_staging_with_a_clear_error() {
    let store = TempDir::new().unwrap();
    create_instance(store.path(), "hello-abc123", "hello", "github:owner/repo");
    let bundle = new_bundle("hello", "Hello", "0.2.0");
    stage_update_bundle(
        store_path(&store),
        "hello-abc123",
        dir_source(&bundle),
        "github:owner/repo".to_string(),
    )
    .unwrap();

    // Residue shape of an interrupted commit: source.json present, bundle gone.
    let pending = store.path().join("hello-abc123").join(UPDATE_SUBDIR);
    fs::remove_dir_all(pending.join("app")).unwrap();

    let err = commit_update(store_path(&store), "hello-abc123").unwrap_err();
    assert!(err.to_string().contains("incomplete"), "got: {err}");
    assert!(!pending.exists(), "the unusable staging is dropped");
}
