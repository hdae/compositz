//! The full lifecycle round-trip
//! (import → install → up → down → remove data → remove image) against a REAL
//! Docker engine.
//!
//! DOUBLE-GATED and destructive — it creates and destroys real Docker objects:
//!   COMPOSITZ_E2E=1 cargo test -p compositz-core --test e2e_roundtrip -- --ignored
//! It NEVER runs in a plain `cargo test`. Safety invariants (the dev engine is the
//! user's real Docker):
//!   - the app id is `test`, so the container is `compositz-test-<rand>` and every
//!     object carries the `io.compositz.instance` label;
//!   - teardown is by EXACT id/name (down + remove_instance_data + remove_instance_image),
//!     never a prune or bulk operation, and runs even if an assertion fails so nothing
//!     is leaked into the user's Docker;
//!   - shared cache volumes are never referenced (this recipe declares none).

use std::fs;

use std::collections::HashMap;

use compositz_core::{
    BundleSource, IngestOpts, Instance, LaunchConfig, RemoveDataOpts, connect, down, ingest_bundle,
    install_instance, instance_image_tag, remove_instance_data, remove_instance_image, up,
};
use futures_util::StreamExt;
use tempfile::TempDir;

const RECIPE: &str = "manifestVersion: 2\nid: test\nname: E2E Test\nversion: \"0.1.0\"\nbuild: { dockerfile: Dockerfile }\nmounts:\n  - { name: data, target: /data }\ngpu: none\n";
// A tiny, long-lived container so `up` has something to keep running until `down`.
const DOCKERFILE: &str = "FROM alpine:3\nCMD [\"sleep\", \"3600\"]\n";

fn gated() -> bool {
    std::env::var("COMPOSITZ_E2E").as_deref() == Ok("1")
}

fn ingest_test_recipe(store: &TempDir) -> Instance {
    let src = TempDir::new().unwrap();
    fs::write(src.path().join("compositz.yaml"), RECIPE).unwrap();
    fs::write(src.path().join("Dockerfile"), DOCKERFILE).unwrap();
    ingest_bundle(
        BundleSource::Dir {
            dir: src.path().to_str().unwrap().to_string(),
        },
        store.path().to_str().unwrap(),
        IngestOpts::default(),
    )
    .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "destructive real-engine round-trip; run with COMPOSITZ_E2E=1 and --ignored"]
async fn full_lifecycle_roundtrip_on_the_real_engine() {
    if !gated() {
        return;
    }
    let engine = connect().expect("connect to the engine");
    let store = TempDir::new().unwrap();
    let instance = ingest_test_recipe(&store);
    // Sanity: the container name is compositz-test-* (the safety-scoped prefix).
    assert!(
        instance.instance_id.starts_with("test-"),
        "instance id must be test-* for the safety prefix, got {}",
        instance.instance_id
    );

    // --- install (build) ---------------------------------------------------
    let mut install = install_instance(&engine, &instance);
    let mut install_error: Option<String> = None;
    while let Some(item) = install.next().await {
        match item {
            Ok(progress) => {
                if let Some(err) = progress.error {
                    install_error = Some(err);
                }
            }
            Err(e) => install_error = Some(e.to_string()),
        }
    }

    // --- up ----------------------------------------------------------------
    let up_result = if install_error.is_none() {
        Some(up(&engine, &instance, &LaunchConfig::default()).await)
    } else {
        None
    };

    // --- teardown (ALWAYS runs — exact-id / label-scoped) ------------------
    let down_result = down(&engine, &instance.instance_id, Some(2)).await;
    let remove_data = remove_instance_data(&engine, &instance, RemoveDataOpts::default()).await;
    let remove_image = remove_instance_image(&engine, &instance).await;

    // --- assertions (after teardown, so a failure never leaks objects) -----
    assert!(install_error.is_none(), "install failed: {install_error:?}");
    let up_result = up_result.unwrap().expect("up should succeed");
    assert!(
        !up_result.id.is_empty(),
        "up returned an empty container id"
    );
    assert!(!up_result.used_gpu, "gpu:none must not attach a GPU");

    down_result.expect("down should succeed");
    let remove_data = remove_data.expect("remove_instance_data should succeed");
    // The `data` volume was auto-created at container create and then removed by id.
    assert!(
        remove_data
            .volumes_removed
            .iter()
            .any(|v| v == &format!("compositz_{}_data", instance.instance_id)),
        "expected the per-instance data volume to be removed, got {:?}",
        remove_data.volumes_removed
    );
    remove_image.expect("remove_instance_image should succeed");

    // Prove EXACT cleanup — nothing this instance created is left in the engine.
    let mut label_filter: HashMap<String, Vec<String>> = HashMap::new();
    label_filter.insert(
        "label".to_string(),
        vec![format!("io.compositz.instance={}", instance.instance_id)],
    );
    let remaining = engine
        .list_containers(true, label_filter)
        .await
        .expect("list containers");
    assert!(
        remaining.is_empty(),
        "container leaked: {:?}",
        remaining.iter().map(|c| &c.name).collect::<Vec<_>>()
    );
    let built = instance_image_tag(&instance.manifest, &instance.instance_id);
    assert!(
        !engine.image_exists(&built).await.expect("image_exists"),
        "built image leaked: {built}"
    );
}
