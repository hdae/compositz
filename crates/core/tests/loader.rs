//! Behavior tests for recipe-bundle loading: these pin the context-assembly and
//! validation directly, since the context feeds `docker build`.

use std::fs;

use compositz_core::recipe::loader::load_recipe;
use tempfile::TempDir;

const MANIFEST: &str = "manifestVersion: 2\nid: demo\nname: Demo\nversion: \"0.1.0\"\nbuild: { dockerfile: Dockerfile }\ngpu: none\n";

#[test]
fn load_recipe_reads_context_excluding_manifest_and_dotfiles() {
    let dir = TempDir::new().unwrap();
    let root = dir.path();
    fs::write(root.join("compositz.yaml"), MANIFEST).unwrap();
    fs::write(root.join("Dockerfile"), "FROM scratch\n").unwrap();
    fs::write(root.join(".dockerignore"), "node_modules\n").unwrap();
    fs::create_dir(root.join("rootfs")).unwrap();
    fs::write(root.join("rootfs/run.sh"), "#!/bin/sh\n").unwrap();
    fs::create_dir(root.join(".git")).unwrap();
    fs::write(root.join(".git/config"), "junk\n").unwrap();

    let recipe = load_recipe(root.to_str().unwrap()).unwrap();
    assert_eq!(recipe.id, "demo");

    let mut paths: Vec<&str> = recipe.context.iter().map(|f| f.path.as_str()).collect();
    paths.sort();
    // The manifest itself, the top-level dotfile, and everything under `.git`
    // are excluded; the Dockerfile and the nested asset remain.
    assert_eq!(paths, vec!["Dockerfile", "rootfs/run.sh"]);
}

#[test]
fn load_recipe_errors_when_the_declared_dockerfile_is_missing() {
    let dir = TempDir::new().unwrap();
    let root = dir.path();
    // Manifest declares `dockerfile: Dockerfile` but none is present.
    fs::write(root.join("compositz.yaml"), MANIFEST).unwrap();
    fs::write(root.join("README.md"), "docs\n").unwrap();

    let err = load_recipe(root.to_str().unwrap()).unwrap_err();
    assert!(err.to_string().contains("Dockerfile"), "got: {err}");
}

#[test]
fn load_recipe_errors_when_the_manifest_is_absent() {
    let dir = TempDir::new().unwrap();
    let err = load_recipe(dir.path().to_str().unwrap()).unwrap_err();
    assert!(err.to_string().contains("manifest not found"), "got: {err}");
}
