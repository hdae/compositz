//! Behavior tests for the container-spec derivation, ported from
//! `packages/core/src/recipe/run_test.ts`. Assertions are against bollard's own
//! `ContainerCreateBody` / `Mount` / … (the spec type `run.rs` produces).

use std::collections::{BTreeMap, HashSet};

use bollard::models::{
    ContainerCreateBody, HostConfig, Mount, MountBindOptions, MountType, PortBinding,
};
use compositz_core::recipe::manifest::{Placement, parse_manifest};
use compositz_core::{
    LaunchConfig, WebEndpoint, instance_container_name, instance_image_tag, merge_launch,
    persisted_mounts, resolve_host_ports, to_create_spec, web_endpoints, web_url,
};

const INST: &str = "comfyui-a1b2c3";

fn comfy() -> compositz_core::Manifest {
    parse_manifest(
        r#"
manifestVersion: 2
id: comfyui
name: ComfyUI
version: "0.2.0"
build: {}
ports:
  - name: ui
    container: 8188
    host: 7860
    web: true
  - name: api
    container: 9000
    protocol: udp
mounts:
  - name: output
    target: /out
    placement: bind
  - name: models
    target: /data
cache:
  - type: venv
  - type: huggingface
env:
  - name: FOO
    default: bar
gpu: preferred
"#,
    )
    .unwrap()
}

fn launch_data_root(root: &str) -> LaunchConfig {
    LaunchConfig {
        data_root: Some(root.to_string()),
        ..Default::default()
    }
}

fn host_config(spec: &ContainerCreateBody) -> &HostConfig {
    spec.host_config.as_ref().unwrap()
}

fn bind_mount(source: &str, target: &str) -> Mount {
    Mount {
        typ: Some(MountType::BIND),
        source: Some(source.to_string()),
        target: Some(target.to_string()),
        bind_options: Some(MountBindOptions {
            create_mountpoint: Some(true),
            ..Default::default()
        }),
        ..Default::default()
    }
}

fn vol_mount(source: &str, target: &str) -> Mount {
    Mount {
        typ: Some(MountType::VOLUME),
        source: Some(source.to_string()),
        target: Some(target.to_string()),
        ..Default::default()
    }
}

#[test]
fn naming_derives_from_brand_and_instance_id() {
    let m = comfy();
    assert_eq!(
        instance_image_tag(&m, INST),
        "compositz/comfyui-a1b2c3:0.2.0"
    );
    assert_eq!(instance_container_name(INST), "compositz-comfyui-a1b2c3");
}

#[test]
fn image_based_recipe_runs_the_referenced_image() {
    let img = parse_manifest(
        "manifestVersion: 2\nid: ollama\nname: Ollama\nversion: \"0.6.0\"\nimage: ollama/ollama:0.6.0",
    )
    .unwrap();
    assert_eq!(instance_image_tag(&img, "ollama-z9"), "ollama/ollama:0.6.0");
}

#[test]
fn web_endpoints_lists_each_web_port_and_web_url_is_the_first() {
    let multi = parse_manifest(
        r#"
manifestVersion: 2
id: x
name: X
version: "1"
build: {}
ports:
  - name: ui
    container: 80
    host: 8080
    web: true
  - name: admin
    container: 9000
    host: 9090
    web: true
    path: /admin
"#,
    )
    .unwrap();
    assert_eq!(
        web_endpoints(&multi, &LaunchConfig::default()),
        vec![
            WebEndpoint {
                name: "ui".to_string(),
                url: "http://localhost:8080/".to_string()
            },
            WebEndpoint {
                name: "admin".to_string(),
                url: "http://localhost:9090/admin".to_string()
            },
        ]
    );
    assert_eq!(
        web_url(&multi, &LaunchConfig::default()).as_deref(),
        Some("http://localhost:8080/")
    );
}

#[test]
fn web_url_honors_a_launch_host_port_remap() {
    let launch = LaunchConfig {
        host_ports: BTreeMap::from([("ui".to_string(), 7000)]),
        ..Default::default()
    };
    assert_eq!(
        web_url(&comfy(), &launch).as_deref(),
        Some("http://localhost:7000/")
    );
}

#[test]
fn to_create_spec_maps_ports_mounts_caches_env_gpu() {
    let spec = to_create_spec(&comfy(), INST, &launch_data_root("/root"), None).unwrap();
    assert_eq!(
        spec.image.as_deref(),
        Some("compositz/comfyui-a1b2c3:0.2.0")
    );
    assert_eq!(
        spec.exposed_ports,
        Some(vec!["8188/tcp".to_string(), "9000/udp".to_string()])
    );
    let hc = host_config(&spec);
    let pb = hc.port_bindings.as_ref().unwrap();
    assert_eq!(
        pb["8188/tcp"],
        Some(vec![PortBinding {
            host_port: Some("7860".to_string()),
            ..Default::default()
        }])
    );
    assert_eq!(
        pb["9000/udp"],
        Some(vec![PortBinding {
            host_port: Some("9000".to_string()),
            ..Default::default()
        }])
    );

    // bind => host path under data-root/<instanceId>; volume => per-instance volume.
    assert_eq!(
        hc.mounts,
        Some(vec![
            bind_mount("/root/comfyui-a1b2c3/output", "/out"),
            vol_mount("compositz_comfyui-a1b2c3_models", "/data"),
            vol_mount("compositz_uv", "/compositz/uv"),
            vol_mount("compositz_hf", "/compositz/hf"),
        ])
    );

    // user env (default), then managed cache vars (VIRTUAL_ENV and
    // UV_PROJECT_ENVIRONMENT share the same path), then the instance marker.
    assert_eq!(
        spec.env,
        Some(vec![
            "FOO=bar".to_string(),
            "UV_CACHE_DIR=/compositz/uv/cache".to_string(),
            "VIRTUAL_ENV=/compositz/uv/venvs/comfyui-a1b2c3".to_string(),
            "UV_PROJECT_ENVIRONMENT=/compositz/uv/venvs/comfyui-a1b2c3".to_string(),
            "UV_PYTHON_INSTALL_DIR=/compositz/uv/python".to_string(),
            "HF_HOME=/compositz/hf".to_string(),
            "COMPOSITZ_INSTANCE=comfyui-a1b2c3".to_string(),
        ])
    );

    assert_eq!(
        hc.device_requests.as_ref().unwrap()[0].capabilities,
        Some(vec![vec!["gpu".to_string()]])
    );
    let labels = spec.labels.as_ref().unwrap();
    assert_eq!(labels["io.compositz.recipe"], "comfyui");
    assert_eq!(labels["io.compositz.instance"], "comfyui-a1b2c3");
}

#[test]
fn to_create_spec_different_instance_id_isolates_venv_label_and_marker() {
    let launch = LaunchConfig {
        data_root: Some("/root".to_string()),
        env: BTreeMap::from([("FOO".to_string(), "baz".to_string())]),
        ..Default::default()
    };
    let spec = to_create_spec(&comfy(), "comfyui-x7y8z9", &launch, None).unwrap();
    let env = spec.env.unwrap();
    assert!(env.contains(&"FOO=baz".to_string()));
    assert!(env.contains(&"VIRTUAL_ENV=/compositz/uv/venvs/comfyui-x7y8z9".to_string()));
    assert!(env.contains(&"UV_PROJECT_ENVIRONMENT=/compositz/uv/venvs/comfyui-x7y8z9".to_string()));
    assert!(env.contains(&"COMPOSITZ_INSTANCE=comfyui-x7y8z9".to_string()));
    assert_eq!(
        spec.labels.unwrap()["io.compositz.instance"],
        "comfyui-x7y8z9"
    );
}

#[test]
fn to_create_spec_placement_override_flips_bind_to_volume() {
    let launch = LaunchConfig {
        placement: BTreeMap::from([("output".to_string(), Placement::Volume)]),
        ..Default::default()
    };
    let spec = to_create_spec(&comfy(), INST, &launch, None).unwrap();
    let out = host_config(&spec)
        .mounts
        .as_ref()
        .unwrap()
        .iter()
        .find(|x| x.target.as_deref() == Some("/out"))
        .cloned();
    assert_eq!(
        out,
        Some(vol_mount("compositz_comfyui-a1b2c3_output", "/out"))
    );
}

#[test]
fn to_create_spec_bind_mount_without_data_root_throws() {
    let err = to_create_spec(&comfy(), INST, &LaunchConfig::default(), None).unwrap_err();
    assert!(
        err.to_string().contains("bind mount but no dataRoot"),
        "got: {err}"
    );
}

#[test]
fn persisted_mounts_is_the_shared_derivation() {
    let m = comfy();
    let mounts = persisted_mounts(&m, INST, Some("/root"), &BTreeMap::new()).unwrap();
    assert_eq!(
        mounts,
        vec![
            bind_mount("/root/comfyui-a1b2c3/output", "/out"),
            vol_mount("compositz_comfyui-a1b2c3_models", "/data"),
        ]
    );
    // Exactly what to_create_spec attaches (before caches) — export / data deletion
    // resolve a mount name to the SAME volume/bind dir the container runs with.
    let spec = to_create_spec(&m, INST, &launch_data_root("/root"), None).unwrap();
    let spec_mounts = host_config(&spec).mounts.clone().unwrap();
    assert_eq!(&spec_mounts[..mounts.len()], &mounts[..]);
}

#[test]
fn persisted_mounts_honors_a_placement_override() {
    let placement = BTreeMap::from([("output".to_string(), Placement::Volume)]);
    let mounts = persisted_mounts(&comfy(), INST, None, &placement).unwrap();
    assert_eq!(
        mounts[0],
        vol_mount("compositz_comfyui-a1b2c3_output", "/out")
    );
}

#[test]
fn to_create_spec_with_gpu_false_omits_device_requests() {
    let spec = to_create_spec(&comfy(), INST, &launch_data_root("/root"), Some(false)).unwrap();
    assert_eq!(host_config(&spec).device_requests, None);
}

#[test]
fn gpu_none_manifest_attaches_no_gpu() {
    let none =
        parse_manifest("manifestVersion: 2\nid: x\nname: X\nversion: '1'\nbuild: {}\ngpu: none")
            .unwrap();
    let spec = to_create_spec(&none, "x-1", &LaunchConfig::default(), None).unwrap();
    assert_eq!(host_config(&spec).device_requests, None);
}

#[test]
fn to_create_spec_volume_only_recipe_needs_no_data_root() {
    let vol = parse_manifest(
        r#"
manifestVersion: 2
id: x
name: X
version: "1"
build: {}
mounts:
  - name: data
    target: /data
"#,
    )
    .unwrap();
    let spec = to_create_spec(&vol, "x-1", &LaunchConfig::default(), None).unwrap();
    assert_eq!(
        host_config(&spec).mounts,
        Some(vec![vol_mount("compositz_x-1_data", "/data")])
    );
}

#[test]
fn to_create_spec_two_ports_on_one_container_port_publish_to_both() {
    let dual = parse_manifest(
        r#"
manifestVersion: 2
id: x
name: X
version: "1"
build: {}
ports:
  - name: a
    container: 80
    host: 8080
  - name: b
    container: 80
    host: 8081
"#,
    )
    .unwrap();
    let spec = to_create_spec(&dual, "x-1", &LaunchConfig::default(), None).unwrap();
    assert_eq!(
        host_config(&spec).port_bindings.as_ref().unwrap()["80/tcp"],
        Some(vec![
            PortBinding {
                host_port: Some("8080".to_string()),
                ..Default::default()
            },
            PortBinding {
                host_port: Some("8081".to_string()),
                ..Default::default()
            },
        ])
    );
}

#[test]
fn to_create_spec_managed_cache_var_overrides_a_colliding_user_env() {
    let clash = parse_manifest(
        r#"
manifestVersion: 2
id: x
name: X
version: "1"
build: {}
cache:
  - type: huggingface
env:
  - name: HF_HOME
    default: /wrong
"#,
    )
    .unwrap();
    let spec = to_create_spec(&clash, "x-1", &LaunchConfig::default(), None).unwrap();
    let hf: Vec<&String> = spec
        .env
        .as_ref()
        .unwrap()
        .iter()
        .filter(|e| e.starts_with("HF_HOME="))
        .collect();
    assert_eq!(hf, vec!["HF_HOME=/compositz/hf"]);
}

#[test]
fn to_create_spec_user_mount_target_colliding_with_a_cache_throws() {
    let clash = parse_manifest(
        r#"
manifestVersion: 2
id: x
name: X
version: "1"
build: {}
mounts:
  - name: data
    target: /compositz/hf
cache:
  - type: huggingface
"#,
    )
    .unwrap();
    let err = to_create_spec(&clash, "x-1", &LaunchConfig::default(), None).unwrap_err();
    assert!(
        err.to_string().contains("duplicate mount target"),
        "got: {err}"
    );
}

#[test]
fn resolve_host_ports_bumps_colliding_ports() {
    let out =
        resolve_host_ports(&[("ui", 8080), ("api", 8081)], &HashSet::from([8080, 8081])).unwrap();
    assert_eq!(
        out,
        BTreeMap::from([("ui".to_string(), 8082), ("api".to_string(), 8083)])
    );
}

#[test]
fn resolve_host_ports_leaves_free_ports_untouched() {
    let out = resolve_host_ports(&[("ui", 9000)], &HashSet::from([8080])).unwrap();
    assert_eq!(out, BTreeMap::from([("ui".to_string(), 9000)]));
}

#[test]
fn resolve_host_ports_throws_when_no_free_port_remains() {
    let taken = HashSet::from([65534, 65535]);
    let err = resolve_host_ports(&[("ui", 65534)], &taken).unwrap_err();
    assert!(err.to_string().contains("no free host port"), "got: {err}");
}

#[test]
fn resolve_host_ports_avoids_self_collision_among_own_ports() {
    let out = resolve_host_ports(&[("a", 5000), ("b", 5000)], &HashSet::new()).unwrap();
    assert_eq!(
        out,
        BTreeMap::from([("a".to_string(), 5000), ("b".to_string(), 5001)])
    );
}

#[test]
fn create_spec_serializes_to_the_docker_api_wire_shape() {
    // The spec feeds `create_container` (Phase 1g); prove it serializes to the
    // Docker API JSON shape without an engine. Guards the bollard-version quirk that
    // `exposed_ports` is a `Vec<String>` in Rust but a `{"8188/tcp":{}}` OBJECT on
    // the wire (custom serializer) — a bare array would be rejected by the daemon.
    let spec = to_create_spec(&comfy(), INST, &launch_data_root("/root"), None).unwrap();
    let json = serde_json::to_value(&spec).unwrap();

    assert_eq!(json["ExposedPorts"]["8188/tcp"], serde_json::json!({}));
    assert_eq!(json["ExposedPorts"]["9000/udp"], serde_json::json!({}));
    assert!(
        json["ExposedPorts"].as_object().is_some(),
        "ExposedPorts must be an object"
    );

    let mounts = json["HostConfig"]["Mounts"].as_array().unwrap();
    assert_eq!(mounts[0]["Type"], "bind");
    assert_eq!(mounts[0]["Source"], "/root/comfyui-a1b2c3/output");
    assert_eq!(mounts[0]["Target"], "/out");
    assert_eq!(mounts[0]["BindOptions"]["CreateMountpoint"], true);
    assert_eq!(mounts[1]["Type"], "volume");

    assert_eq!(
        json["HostConfig"]["PortBindings"]["8188/tcp"][0]["HostPort"],
        "7860"
    );
    assert_eq!(json["Labels"]["io.compositz.instance"], "comfyui-a1b2c3");
    assert!(
        json["Env"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e == "FOO=bar")
    );
    assert_eq!(
        json["HostConfig"]["DeviceRequests"][0]["Capabilities"][0][0],
        "gpu"
    );
}

#[test]
fn env_collision_keeps_the_user_vars_position_and_trailing_vars_after() {
    // Closes a gap the presence-only collision test misses: a cache var that
    // overrides a colliding user var must keep that var's ORIGINAL position, and a
    // later user var must still follow it. This is the JS `Map.set` semantic the
    // `OrderedEnv` reproduces — an order regression would silently reshuffle `Env`.
    let m = parse_manifest(
        r#"
manifestVersion: 2
id: x
name: X
version: "1"
build: {}
cache:
  - type: huggingface
env:
  - name: HF_HOME
    default: /wrong
  - name: LATER
    default: zzz
"#,
    )
    .unwrap();
    let spec = to_create_spec(&m, "x-1", &LaunchConfig::default(), None).unwrap();
    assert_eq!(
        spec.env,
        Some(vec![
            "HF_HOME=/compositz/hf".to_string(), // updated in place at position 0
            "LATER=zzz".to_string(),
            "COMPOSITZ_INSTANCE=x-1".to_string(),
        ])
    );
}

#[test]
fn with_gpu_true_attaches_a_gpu_even_on_a_gpu_none_manifest() {
    // Parity of `opts.withGpu ?? (m.gpu !== "none")`: an explicit override wins over
    // the manifest default in BOTH directions (false omits — already tested; true
    // attaches despite gpu:none).
    let none =
        parse_manifest("manifestVersion: 2\nid: x\nname: X\nversion: '1'\nbuild: {}\ngpu: none")
            .unwrap();
    let spec = to_create_spec(&none, "x-1", &LaunchConfig::default(), Some(true)).unwrap();
    assert!(host_config(&spec).device_requests.is_some());
}

#[test]
fn resolve_host_ports_can_use_65535_when_free_but_errors_when_taken() {
    // Boundary: 65535 is a valid host port (no off-by-one excluding it), but once
    // taken there is nowhere to bump to.
    assert_eq!(
        resolve_host_ports(&[("ui", 65535)], &HashSet::new()).unwrap(),
        BTreeMap::from([("ui".to_string(), 65535)])
    );
    assert!(resolve_host_ports(&[("ui", 65535)], &HashSet::from([65535])).is_err());
}

// --- merge_launch (persisted override ⊕ in-memory overlay) ------------------

#[test]
fn merge_launch_over_wins_per_sub_key() {
    let base = LaunchConfig {
        host_ports: BTreeMap::from([("ui".to_string(), 8188), ("api".to_string(), 9000)]),
        env: BTreeMap::from([
            ("A".to_string(), "1".to_string()),
            ("B".to_string(), "2".to_string()),
        ]),
        ..Default::default()
    };
    let over = LaunchConfig {
        host_ports: BTreeMap::from([("ui".to_string(), 8200)]),
        env: BTreeMap::from([("B".to_string(), "9".to_string())]),
        ..Default::default()
    };
    assert_eq!(
        merge_launch(&base, &over),
        LaunchConfig {
            host_ports: BTreeMap::from([("ui".to_string(), 8200), ("api".to_string(), 9000)]),
            env: BTreeMap::from([
                ("A".to_string(), "1".to_string()),
                ("B".to_string(), "9".to_string())
            ]),
            placement: BTreeMap::new(),
            data_root: None,
        }
    );
}

#[test]
fn merge_launch_empty_overlay_returns_the_base() {
    let base = LaunchConfig {
        host_ports: BTreeMap::from([("ui".to_string(), 8188)]),
        placement: BTreeMap::from([("out".to_string(), Placement::Bind)]),
        ..Default::default()
    };
    assert_eq!(merge_launch(&base, &LaunchConfig::default()), base);
}

#[test]
fn merge_launch_data_root_set_only_when_supplied() {
    // Neither side supplies it ⇒ None (never clobber the default `up` fills in).
    assert_eq!(
        merge_launch(&LaunchConfig::default(), &LaunchConfig::default()).data_root,
        None
    );
    let with_base = LaunchConfig {
        data_root: Some("/data".to_string()),
        ..Default::default()
    };
    assert_eq!(
        merge_launch(&with_base, &LaunchConfig::default())
            .data_root
            .as_deref(),
        Some("/data")
    );
    let over = LaunchConfig {
        data_root: Some("/over".to_string()),
        ..Default::default()
    };
    let base = LaunchConfig {
        data_root: Some("/base".to_string()),
        ..Default::default()
    };
    assert_eq!(
        merge_launch(&base, &over).data_root.as_deref(),
        Some("/over")
    );
}
