//! Behavior tests for the wslc argv projection: the SAME `ContainerCreateBody`
//! the bollard path sends, rendered to `wslc create` arguments — and a loud
//! failure for anything the projection cannot carry (never a reduced launch).

use std::ffi::OsString;
use std::path::Path;

use bollard::models::{ContainerCreateBody, DeviceRequest};
use compositz_core::recipe::manifest::parse_manifest;
use compositz_core::wslc_cli::{env_file_lines, wslc_create_args};
use compositz_core::{LaunchConfig, to_create_spec};

const INST: &str = "hello-a1b2c3";

fn hello() -> compositz_core::Manifest {
    parse_manifest(
        r#"
manifestVersion: 2
id: hello
name: Hello
version: "1.0"
build: {}
ports:
  - name: ui
    container: 80
    host: 8090
    web: true
mounts:
  - name: models
    target: /data
cache:
  - type: venv
  - type: huggingface
env:
  - name: FOO
    default: bar
"#,
    )
    .unwrap()
}

fn os(args: &[&str]) -> Vec<OsString> {
    args.iter().map(OsString::from).collect()
}

#[test]
fn projects_the_full_spec_into_wslc_create_argv() {
    let body = to_create_spec(&hello(), INST, &LaunchConfig::default(), Some(false)).unwrap();
    let env_file = Path::new("/tmp/env-file");
    let args = wslc_create_args("compositz-hello-a1b2c3", &body, Some(env_file)).unwrap();

    assert_eq!(
        args,
        os(&[
            "create",
            "--name",
            "compositz-hello-a1b2c3",
            "--label",
            "io.compositz.instance=hello-a1b2c3",
            "--label",
            "io.compositz.managed=true",
            "--label",
            "io.compositz.recipe=hello",
            "--label",
            "io.compositz.version=1.0",
            "-p",
            "8090:80",
            "-v",
            "compositz_hello-a1b2c3_models:/data",
            "-v",
            "compositz_uv:/compositz/uv",
            "-v",
            "compositz_hf:/compositz/hf",
            "--env-file",
            "/tmp/env-file",
            "compositz/hello-a1b2c3:1.0",
        ])
    );
}

#[test]
fn env_lines_carry_manifest_cache_and_instance_vars_in_spec_order() {
    let body = to_create_spec(&hello(), INST, &LaunchConfig::default(), Some(false)).unwrap();
    let lines = env_file_lines(&body).unwrap();
    assert_eq!(
        lines,
        vec![
            "FOO=bar",
            "UV_CACHE_DIR=/compositz/uv/cache",
            "VIRTUAL_ENV=/compositz/uv/venvs/hello-a1b2c3",
            "UV_PROJECT_ENVIRONMENT=/compositz/uv/venvs/hello-a1b2c3",
            "UV_PYTHON_INSTALL_DIR=/compositz/uv/python",
            "HF_HOME=/compositz/hf",
            "COMPOSITZ_INSTANCE=hello-a1b2c3",
        ]
    );
}

#[test]
fn gpu_request_projects_to_gpus_all() {
    let m = parse_manifest(
        "manifestVersion: 2\nid: g\nname: G\nversion: \"1\"\nbuild: {}\ngpu: required",
    )
    .unwrap();
    let body = to_create_spec(&m, INST, &LaunchConfig::default(), Some(true)).unwrap();
    let args = wslc_create_args("c", &body, Some(Path::new("/tmp/env"))).unwrap();
    assert!(args.windows(2).any(|w| *w == os(&["--gpus", "all"])[..]));
}

#[test]
fn udp_port_fails_loudly() {
    let m = parse_manifest(
        r#"
manifestVersion: 2
id: u
name: U
version: "1"
build: {}
ports:
  - name: api
    container: 9000
    protocol: udp
"#,
    )
    .unwrap();
    let body = to_create_spec(&m, INST, &LaunchConfig::default(), Some(false)).unwrap();
    let err = wslc_create_args("c", &body, None).unwrap_err();
    assert!(err.to_string().contains("udp"), "err: {err}");
}

#[test]
fn bind_mount_fails_loudly() {
    let m = parse_manifest(
        r#"
manifestVersion: 2
id: b
name: B
version: "1"
build: {}
mounts:
  - name: out
    target: /out
    placement: bind
"#,
    )
    .unwrap();
    let launch = LaunchConfig {
        data_root: Some("C:/data".to_string()),
        ..Default::default()
    };
    let body = to_create_spec(&m, INST, &launch, Some(false)).unwrap();
    let err = wslc_create_args("c", &body, None).unwrap_err();
    assert!(err.to_string().contains("bind"), "err: {err}");
}

fn minimal_body() -> ContainerCreateBody {
    let m =
        parse_manifest("manifestVersion: 2\nid: m\nname: M\nversion: \"1\"\nbuild: {}").unwrap();
    to_create_spec(&m, INST, &LaunchConfig::default(), Some(false)).unwrap()
}

#[test]
fn unhandled_body_fields_fail_instead_of_launching_reduced() {
    // Body-level remainder.
    let mut body = minimal_body();
    body.user = Some("root".to_string());
    assert!(wslc_create_args("c", &body, None).is_err());

    // Host-config-level remainder.
    let mut body = minimal_body();
    body.host_config.get_or_insert_default().network_mode = Some("host".to_string());
    assert!(wslc_create_args("c", &body, None).is_err());

    // A tty container is not expressible without -t semantics.
    let mut body = minimal_body();
    body.tty = Some(true);
    assert!(wslc_create_args("c", &body, None).is_err());
}

#[test]
fn foreign_device_request_is_not_widened_to_gpus_all() {
    let mut body = minimal_body();
    body.host_config.get_or_insert_default().device_requests = Some(vec![DeviceRequest {
        device_ids: Some(vec!["GPU-0".to_string()]),
        ..Default::default()
    }]);
    let err = wslc_create_args("c", &body, None).unwrap_err();
    assert!(err.to_string().contains("device request"), "err: {err}");
}

#[test]
fn pinned_host_ip_fails_loudly() {
    let m = parse_manifest(
        "manifestVersion: 2\nid: p\nname: P\nversion: \"1\"\nbuild: {}\nports:\n  - name: ui\n    container: 80\n",
    )
    .unwrap();
    let mut body = to_create_spec(&m, INST, &LaunchConfig::default(), Some(false)).unwrap();
    let bindings = body
        .host_config
        .as_mut()
        .unwrap()
        .port_bindings
        .as_mut()
        .unwrap();
    for binding in bindings.values_mut().flatten() {
        for b in binding.iter_mut() {
            b.host_ip = Some("0.0.0.0".to_string());
        }
    }
    let err = wslc_create_args("c", &body, None).unwrap_err();
    assert!(err.to_string().contains("host IP"), "err: {err}");
}
