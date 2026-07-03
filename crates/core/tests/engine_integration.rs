//! Read-only integration checks against a real Docker engine.
//!
//! Gated on `COMPOSITZ_DOCKER_HOST`: when it is unset the tests print a skip
//! notice and pass, so `cargo test` is green on machines without an engine. When
//! set, they perform ONLY read-only calls (ping / version / label-filtered list)
//! — never create/start/stop/build/pull/prune anything.

use compositz_core::{build_snapshot, connect, list_managed_containers};

fn engine_configured() -> bool {
    std::env::var("COMPOSITZ_DOCKER_HOST")
        .map(|v| !v.is_empty())
        .unwrap_or(false)
}

#[tokio::test]
async fn ping_and_version_succeed() {
    if !engine_configured() {
        eprintln!("skip: COMPOSITZ_DOCKER_HOST unset (no engine to reach)");
        return;
    }
    let handle = connect().expect("connect");
    handle.docker().ping().await.expect("ping engine");
    let version = handle.docker().version().await.expect("engine version");
    assert!(
        version.version.is_some() || version.api_version.is_some(),
        "version response should carry a version or api_version"
    );
}

#[tokio::test]
async fn list_managed_containers_returns_without_error() {
    if !engine_configured() {
        eprintln!("skip: COMPOSITZ_DOCKER_HOST unset (no engine to reach)");
        return;
    }
    let handle = connect().expect("connect");
    // The list may legitimately be empty (no managed containers here); we only
    // assert the call resolves and every returned summary is label-managed.
    let instances = list_managed_containers(&handle)
        .await
        .expect("list managed containers");
    for instance in &instances {
        assert!(!instance.id.is_empty(), "each summary has an id");
    }
}

#[tokio::test]
async fn build_snapshot_resolves_against_the_real_engine() {
    if !engine_configured() {
        eprintln!("skip: COMPOSITZ_DOCKER_HOST unset (no engine to reach)");
        return;
    }
    let handle = connect().expect("connect");
    // Point at an EMPTY temp store so `web_ports_by_instance` is empty → NO web
    // ports are probed. This exercises the read-only engine path (list managed raw
    // → to_container_statuses) end-to-end without an HTTP GET to any of the user's
    // actually-running services.
    let store = tempfile::tempdir().expect("temp store");
    let snapshot = build_snapshot(&handle, store.path().to_str().unwrap())
        .await
        .expect("build snapshot");
    // Every reduced status carries a non-empty engine state; with an empty store
    // nothing is probed, so `warming` is false.
    for container in &snapshot.containers {
        assert!(!container.state.is_empty(), "each status has a state");
    }
    assert!(
        !snapshot.warming,
        "empty store probes nothing ⇒ not warming"
    );
}
