//! Behavior tests for the instance store.
//!
//! Each instance directory is laid down directly — an equivalent fixture that
//! exercises the SAME load / list / remove / config behaviors without depending
//! on the full ingestion path.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use compositz_core::recipe::config::Override;
use compositz_core::recipe::instance::{
    CONFIG_FILE, InstanceMeta, META_FILE, list_instances, load_instance, load_instance_config,
    load_launched_config, remove_instance_dir, save_instance_config, save_launched_config,
    write_meta,
};
use tempfile::TempDir;

fn manifest(id: &str, name: &str) -> String {
    format!(
        "manifestVersion: 2\nid: {id}\nname: {name}\nversion: \"0.1.0\"\nbuild: {{ dockerfile: Dockerfile }}\ngpu: none\n"
    )
}

/// Lay down `<store>/<instanceId>/{app/compositz.yaml, app/Dockerfile, meta.json}`.
fn create_instance(
    store: &Path,
    instance_id: &str,
    app_id: &str,
    name: &str,
    source: Option<&str>,
) {
    let app = store.join(instance_id).join("app");
    fs::create_dir_all(&app).unwrap();
    fs::write(app.join("compositz.yaml"), manifest(app_id, name)).unwrap();
    fs::write(app.join("Dockerfile"), "FROM scratch\n").unwrap();
    if let Some(source) = source {
        fs::write(
            store.join(instance_id).join("meta.json"),
            format!("{{\n  \"source\": \"{source}\"\n}}\n"),
        )
        .unwrap();
    }
}

fn store_path(dir: &TempDir) -> &str {
    dir.path().to_str().unwrap()
}

fn ports(pairs: &[(&str, u32)]) -> Override {
    Override {
        host_ports: Some(pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()),
        ..Override::default()
    }
}

#[test]
fn list_instances_sorts_by_name_and_skips_junk_and_staging_dirs() {
    let store = TempDir::new().unwrap();
    create_instance(store.path(), "zed-1a2b3c", "zed", "Zed", None);
    create_instance(store.path(), "apex-4d5e6f", "apex", "Apex", None);

    // Noise the loader must ignore.
    fs::write(store.path().join("loose-file.txt"), "x").unwrap();
    fs::create_dir(store.path().join(".ingest-leftover")).unwrap();
    fs::create_dir(store.path().join("not-an-instance")).unwrap(); // no app/ bundle

    let list = list_instances(store_path(&store));
    assert_eq!(
        list.iter()
            .map(|i| i.manifest.name.as_str())
            .collect::<Vec<_>>(),
        vec!["Apex", "Zed"]
    );
    let mut ids: Vec<&str> = list.iter().map(|i| i.instance_id.as_str()).collect();
    ids.sort();
    assert_eq!(ids, vec!["apex-4d5e6f", "zed-1a2b3c"]);
}

#[test]
fn list_instances_sorts_by_the_effective_display_name_not_the_manifest_brand() {
    let store = TempDir::new().unwrap();
    create_instance(store.path(), "apex-4d5e6f", "apex", "Apex", None);
    create_instance(store.path(), "apex-7g8h9i", "apex", "Apex", None);
    // Rename the first deployment past "Apex" alphabetically — the list must
    // follow the name the user actually sees, not the shared manifest brand.
    write_meta(
        store
            .path()
            .join("apex-4d5e6f")
            .join(META_FILE)
            .to_str()
            .unwrap(),
        &InstanceMeta {
            name: Some("Zulu (copy)".to_string()),
            ..InstanceMeta::default()
        },
    )
    .unwrap();

    let list = list_instances(store_path(&store));
    assert_eq!(
        list.iter().map(|i| i.display_name()).collect::<Vec<_>>(),
        vec!["Apex", "Zulu (copy)"]
    );
    assert_eq!(list[0].instance_id, "apex-7g8h9i");
    assert_eq!(list[1].instance_id, "apex-4d5e6f");
}

#[test]
fn load_instance_rejects_a_directory_whose_name_is_not_a_valid_instance_id() {
    let store = TempDir::new().unwrap();
    // A well-formed bundle under an id-violating dir name (uppercase + underscore).
    create_instance(store.path(), "Bad_Dir", "hello", "Hello", None);

    let err = load_instance(store.path().join("Bad_Dir").to_str().unwrap());
    assert!(err.is_err(), "an id-violating dir must fail loud");
    // …and the store listing skips it rather than surfacing a broken instance.
    assert_eq!(list_instances(store_path(&store)).len(), 0);
}

#[test]
fn load_instance_derives_id_from_directory_name_and_reads_meta() {
    let store = TempDir::new().unwrap();
    create_instance(store.path(), "hello-abc123", "hello", "Hello", Some("test"));

    let loaded = load_instance(store.path().join("hello-abc123").to_str().unwrap()).unwrap();
    assert_eq!(loaded.instance_id, "hello-abc123");
    assert_eq!(loaded.app_id, "hello");
    assert_eq!(loaded.meta.source.as_deref(), Some("test"));
}

#[test]
fn remove_instance_dir_deletes_the_definition_idempotently() {
    let store = TempDir::new().unwrap();
    create_instance(store.path(), "hello-abc123", "hello", "Hello", None);

    remove_instance_dir(store_path(&store), "hello-abc123").unwrap();
    assert_eq!(list_instances(store_path(&store)).len(), 0);
    // A second removal is a no-op, not an error.
    remove_instance_dir(store_path(&store), "hello-abc123").unwrap();
}

#[test]
fn remove_instance_dir_rejects_a_path_shaped_id_and_the_store_survives() {
    let store = TempDir::new().unwrap();
    create_instance(store.path(), "hello-abc123", "hello", "Hello", None);

    // `rm .` / `rm ..` / traversal / uppercase / empty must ERROR before any
    // filesystem delete — otherwise the recursive remove wipes the whole store.
    for evil in [".", "..", "a/b", "../store", "UPPER", ""] {
        let err = remove_instance_dir(store_path(&store), evil).unwrap_err();
        assert!(
            err.to_string().contains("invalid"),
            "evil {evil:?} got: {err}"
        );
    }
    assert_eq!(list_instances(store_path(&store)).len(), 1); // untouched

    // The real one still works.
    remove_instance_dir(store_path(&store), "hello-abc123").unwrap();
    assert_eq!(list_instances(store_path(&store)).len(), 0);
}

// Listing uses lstat, not stat: a symlink whose target is a valid bundle must
// NOT be listed as an instance. Guards against a regression to the
// symlink-following `Path::is_dir()`.
#[cfg(unix)]
#[test]
fn list_instances_does_not_follow_a_symlinked_entry() {
    let store = TempDir::new().unwrap();
    let target = TempDir::new().unwrap();
    create_instance(target.path(), "real", "real", "Real", None);
    std::os::unix::fs::symlink(target.path().join("real"), store.path().join("linked")).unwrap();

    assert_eq!(list_instances(store_path(&store)).len(), 0);
}

#[test]
fn write_meta_persists_provenance_read_back_on_load() {
    let store = TempDir::new().unwrap();
    create_instance(store.path(), "hello-abc123", "hello", "Hello", None);
    let dir = store.path().join("hello-abc123");

    // No meta.json yet ⇒ empty provenance.
    assert_eq!(
        load_instance(dir.to_str().unwrap()).unwrap().meta,
        InstanceMeta::default()
    );

    let meta = InstanceMeta {
        source: Some("github:owner/repo@main".to_string()),
        created_at: Some("2026-07-03T00:00:00Z".to_string()),
        name: None,
    };
    write_meta(dir.join(META_FILE).to_str().unwrap(), &meta).unwrap();
    assert_eq!(load_instance(dir.to_str().unwrap()).unwrap().meta, meta);
}

// --- per-instance launch override (config.yaml, RI-4) ----------------------

#[test]
fn load_instance_config_of_a_fresh_instance_is_the_empty_override() {
    let store = TempDir::new().unwrap();
    create_instance(store.path(), "hello-abc123", "hello", "Hello", None);
    let dir = store.path().join("hello-abc123");
    assert_eq!(
        load_instance_config(dir.to_str().unwrap()).unwrap(),
        Override::default()
    );
}

#[test]
fn save_then_load_instance_config_round_trips() {
    let store = TempDir::new().unwrap();
    create_instance(store.path(), "hello-abc123", "hello", "Hello", None);
    let dir = store.path().join("hello-abc123");
    let dir = dir.to_str().unwrap();

    let overrides = Override {
        host_ports: Some(BTreeMap::from([("ui".to_string(), 8189u32)])),
        env: Some(BTreeMap::from([("TOKEN".to_string(), "x".to_string())])),
        placement: Some(BTreeMap::from([(
            "out".to_string(),
            compositz_core::recipe::manifest::Placement::Bind,
        )])),
    };
    save_instance_config(dir, &overrides).unwrap();
    assert_eq!(load_instance_config(dir).unwrap(), overrides);
}

#[test]
fn load_instance_config_of_an_invalid_file_fails_loud() {
    let store = TempDir::new().unwrap();
    create_instance(store.path(), "hello-abc123", "hello", "Hello", None);
    let dir = store.path().join("hello-abc123");
    fs::write(dir.join(CONFIG_FILE), "hostPorts: { ui: 70000 }\n").unwrap(); // out of range
    assert!(load_instance_config(dir.to_str().unwrap()).is_err());
}

#[test]
fn launched_config_is_none_until_launched_and_independent_of_config_yaml() {
    let store = TempDir::new().unwrap();
    create_instance(store.path(), "hello-abc123", "hello", "Hello", None);
    let dir = store.path().join("hello-abc123");
    let dir = dir.to_str().unwrap();

    // Never launched ⇒ None (distinct from the empty override).
    assert_eq!(load_launched_config(dir).unwrap(), None);

    // Launch with a given override → recorded separately from config.yaml.
    save_launched_config(dir, &ports(&[("web", 8090)])).unwrap();
    assert_eq!(
        load_launched_config(dir).unwrap(),
        Some(ports(&[("web", 8090)]))
    );

    // Editing config.yaml does NOT change the launched snapshot (divergence detectable).
    save_instance_config(dir, &ports(&[("web", 8099)])).unwrap();
    assert_eq!(
        load_launched_config(dir).unwrap(),
        Some(ports(&[("web", 8090)]))
    );
    assert_eq!(load_instance_config(dir).unwrap(), ports(&[("web", 8099)]));
}
