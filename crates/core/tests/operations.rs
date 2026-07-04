//! Behavior tests for the engine-FREE instance operations.
//! `deconflict_host_ports` reads only the manifests ⊕ config.yaml of the OTHER
//! instances, so it is hermetically testable; `up`/`down`/`install`/`export` need
//! a live engine and are verified by the gated E2E round-trip.

use std::collections::BTreeMap;
use std::fs;

use compositz_core::recipe::config::Override;
use compositz_core::recipe::instance::load_instance_config;
use compositz_core::recipe::operations::{PortBump, deconflict_host_ports};
use compositz_core::{BundleSource, IngestOpts, Instance, ingest_bundle};
use tempfile::TempDir;

fn manifest(id: &str, host: u32) -> String {
    format!(
        "manifestVersion: 2\nid: {id}\nname: {id}\nversion: \"0.1.0\"\nbuild: {{ dockerfile: Dockerfile }}\nports:\n  - {{ name: web, container: 80, host: {host} }}\ngpu: none\n"
    )
}

/// A recipe directory on disk (source for a `dir` ingest).
fn recipe_dir(id: &str, host: u32) -> TempDir {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("compositz.yaml"), manifest(id, host)).unwrap();
    fs::write(dir.path().join("Dockerfile"), "FROM scratch\n").unwrap();
    dir
}

fn ingest(store: &TempDir, src: &TempDir) -> Instance {
    ingest_bundle(
        BundleSource::Dir {
            dir: src.path().to_str().unwrap().to_string(),
        },
        store.path().to_str().unwrap(),
        IngestOpts::default(),
    )
    .unwrap()
}

fn store_str(store: &TempDir) -> &str {
    store.path().to_str().unwrap()
}

#[test]
fn deconflict_the_first_instance_has_no_conflict() {
    let store = TempDir::new().unwrap();
    let src = recipe_dir("web", 8090);
    let a = ingest(&store, &src);

    assert_eq!(
        deconflict_host_ports(store_str(&store), &a).unwrap(),
        vec![]
    );
    // Nothing written — a fresh instance's config stays the empty override.
    assert_eq!(load_instance_config(&a.dir).unwrap(), Override::default());
}

#[test]
fn deconflict_a_colliding_port_is_bumped_persisted_and_reported() {
    let store = TempDir::new().unwrap();
    let src = recipe_dir("web", 8090);
    let a = ingest(&store, &src);
    deconflict_host_ports(store_str(&store), &a).unwrap();
    let b = ingest(&store, &src); // same recipe → wants 8090 too

    assert_eq!(
        deconflict_host_ports(store_str(&store), &b).unwrap(),
        vec![PortBump {
            name: "web".to_string(),
            from: 8090,
            to: 8091
        }]
    );
    // Persisted to B, A untouched.
    assert_eq!(
        load_instance_config(&b.dir).unwrap().host_ports,
        Some(BTreeMap::from([("web".to_string(), 8091)]))
    );
    assert_eq!(load_instance_config(&a.dir).unwrap(), Override::default());
}

#[test]
fn deconflict_taken_set_honors_other_instances_overrides_not_just_manifests() {
    let store = TempDir::new().unwrap();
    let src = recipe_dir("web", 8090);
    let a = ingest(&store, &src);
    deconflict_host_ports(store_str(&store), &a).unwrap(); // A = 8090
    let b = ingest(&store, &src);
    deconflict_host_ports(store_str(&store), &b).unwrap(); // B bumped to 8091 (override)
    let c = ingest(&store, &src);

    // C must avoid A's manifest 8090 AND B's OVERRIDE 8091 → 8092.
    assert_eq!(
        deconflict_host_ports(store_str(&store), &c).unwrap(),
        vec![PortBump {
            name: "web".to_string(),
            from: 8090,
            to: 8092
        }]
    );
}

#[test]
fn deconflict_distinct_ports_do_not_conflict_and_rerunning_is_idempotent() {
    let store = TempDir::new().unwrap();
    let src_a = recipe_dir("web", 8090);
    let src_b = recipe_dir("web", 9000);
    ingest(&store, &src_a); // occupies 8090
    let b = ingest(&store, &src_b);

    assert_eq!(
        deconflict_host_ports(store_str(&store), &b).unwrap(),
        vec![]
    ); // 9000 ≠ 8090
    assert_eq!(
        deconflict_host_ports(store_str(&store), &b).unwrap(),
        vec![]
    ); // again — still none
    assert_eq!(load_instance_config(&b.dir).unwrap(), Override::default());
}

// --- superseded image tag (in-place update reclaim) --------------------------

#[test]
fn superseded_image_tag_names_the_old_build_tag_only_on_a_version_change() {
    let store = TempDir::new().unwrap();
    let src = recipe_dir("web", 8090); // build-based, version 0.1.0
    let a = ingest(&store, &src);

    // Version changed → the OLD tag is reclaimable (regardless of what the new
    // manifest looks like — including a build→image flip).
    let expected = format!("compositz/{}:0.1.0", a.instance_id);
    assert_eq!(
        compositz_core::superseded_image_tag(&a, "0.2.0").as_deref(),
        Some(expected.as_str())
    );
    // Same version → the rebuild overwrites the tag in place; nothing to reclaim.
    assert_eq!(compositz_core::superseded_image_tag(&a, "0.1.0"), None);
}

#[test]
fn superseded_image_tag_is_none_for_an_image_based_old_recipe() {
    let store = TempDir::new().unwrap();
    let dir = TempDir::new().unwrap();
    fs::write(
        dir.path().join("compositz.yaml"),
        "manifestVersion: 2\nid: shared\nname: Shared\nversion: \"0.1.0\"\nimage: nginx:alpine\ngpu: none\n",
    )
    .unwrap();
    let a = ingest(&store, &dir);

    // The old recipe never built a per-instance tag — nothing may be removed.
    assert_eq!(compositz_core::superseded_image_tag(&a, "0.2.0"), None);
}
