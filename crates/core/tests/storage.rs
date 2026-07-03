//! Behavior tests for host-path derivation, ported from
//! `packages/core/src/storage_test.ts`. A fake `Platform` injects the OS + env,
//! so the per-OS branch logic is verified without touching the real environment.
//!
//! Core tests run on Linux (the dev host and CI ubuntu), so the runtime path
//! separator is `/` and expectations are written with `/` literally — including
//! the Windows-branch cases, which exercise the `%APPDATA%`/`%USERPROFILE%`
//! branch while still joining with the Linux separator (exactly as the Deno
//! suite does, since `join` there also uses the runtime separator).

use std::collections::HashMap;

use compositz_core::storage::{
    Platform, app_data_dir, bind_host_path, default_data_root, instances_dir,
};

struct FakePlatform {
    os: String,
    vars: HashMap<String, String>,
}

fn platform(os: &str, vars: &[(&str, &str)]) -> FakePlatform {
    FakePlatform {
        os: os.to_string(),
        vars: vars
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
    }
}

impl Platform for FakePlatform {
    fn os(&self) -> &str {
        &self.os
    }
    fn env(&self, key: &str) -> Option<String> {
        self.vars.get(key).cloned()
    }
}

#[test]
fn bind_host_path_nests_data_root_instance_id_name() {
    assert_eq!(
        bind_host_path("/srv/data", "comfyui-a1b2c3", "output"),
        "/srv/data/comfyui-a1b2c3/output"
    );
}

#[test]
fn instances_dir_defaults_to_app_data_instances() {
    let p = platform("linux", &[("HOME", "/home/u")]);
    assert_eq!(
        instances_dir(&p).unwrap(),
        "/home/u/.local/share/compositz/instances"
    );
}

#[test]
fn instances_dir_honors_compositz_instances_dir() {
    let p = platform(
        "linux",
        &[
            ("HOME", "/home/u"),
            ("COMPOSITZ_INSTANCES_DIR", "/custom/store"),
        ],
    );
    assert_eq!(instances_dir(&p).unwrap(), "/custom/store");
}

#[test]
fn app_data_dir_linux_prefers_xdg_data_home() {
    let p = platform("linux", &[("XDG_DATA_HOME", "/x"), ("HOME", "/home/u")]);
    assert_eq!(app_data_dir(&p).unwrap(), "/x/compositz");
}

#[test]
fn app_data_dir_linux_falls_back_to_local_share() {
    let p = platform("linux", &[("HOME", "/home/u")]);
    assert_eq!(app_data_dir(&p).unwrap(), "/home/u/.local/share/compositz");
}

#[test]
fn app_data_dir_windows_uses_appdata() {
    let p = platform("windows", &[("APPDATA", "C:/Users/u/AppData/Roaming")]);
    assert_eq!(
        app_data_dir(&p).unwrap(),
        "C:/Users/u/AppData/Roaming/compositz"
    );
}

#[test]
fn default_data_root_linux_is_home_compositz() {
    let p = platform("linux", &[("HOME", "/home/u")]);
    assert_eq!(default_data_root(&p).unwrap(), "/home/u/Compositz");
}

#[test]
fn default_data_root_windows_is_userprofile_compositz() {
    let p = platform("windows", &[("USERPROFILE", "C:/Users/u")]);
    assert_eq!(default_data_root(&p).unwrap(), "C:/Users/u/Compositz");
}

#[test]
fn home_resolution_errors_when_unset() {
    let p = platform("linux", &[]);
    let err = default_data_root(&p).unwrap_err();
    assert!(
        err.to_string().contains("home directory"),
        "expected a home-directory error, got: {err}"
    );
}
