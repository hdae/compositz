//! Behavior tests for the recipe manifest parser, ported from
//! `packages/core/src/recipe/manifest_test.ts`. These pin the public contract of
//! `parse_manifest`: defaults applied, cross-field rules, and every rejection
//! path — asserted through the same substrings the Deno suite checked.

use compositz_core::recipe::manifest::{
    CacheScope, CacheSpec, EnvSpec, GpuMode, Manifest, MountMapping, Placement, PortMapping,
    Protocol, manifest_json_schema, parse_manifest,
};

/// Assert that parsing `yaml` fails with a message containing `needle`.
#[track_caller]
fn assert_rejects(yaml: &str, needle: &str) {
    match parse_manifest(yaml) {
        Ok(m) => panic!("expected rejection containing {needle:?}, but parsed: {m:?}"),
        Err(e) => {
            let msg = e.to_string();
            assert!(
                msg.contains(needle),
                "expected error to contain {needle:?}, got: {msg}"
            );
        }
    }
}

#[test]
fn recipe_id_accepts_valid_rejects_path_shaped_uppercase_blank() {
    // The id keys the image / container / data dirs / labels, so the charset is
    // asserted through the parse boundary every id actually crosses.
    fn manifest_with_id(id: &str) -> String {
        format!("manifestVersion: 2\nid: {id:?}\nname: X\nversion: \"1\"\nbuild: {{}}\ngpu: none\n")
    }
    for ok in ["comfyui", "hello-web", "a", "x0-9"] {
        assert!(
            parse_manifest(&manifest_with_id(ok)).is_ok(),
            "{ok} should be valid"
        );
    }
    for bad in ["", "..", "../x", "a/b", "Abc", "_x", "x.y", "-x"] {
        assert_rejects(&manifest_with_id(bad), "id");
    }
}

const FULL: &str = r#"
manifestVersion: 2
id: comfyui
name: ComfyUI
version: "0.1.0"
description: Node-based Stable Diffusion UI.
build:
  dockerfile: Dockerfile
  args:
    CUDA: "12.4"
ports:
  - name: ui
    container: 8188
    host: 8188
    web: true
    description: Web UI.
  - name: api
    container: 9000
    protocol: udp
mounts:
  - name: output
    target: /app/output
    placement: bind
  - name: models
    target: /app/models
cache:
  - type: venv
  - type: huggingface
  - type: custom
    name: torch
    env: TORCH_HOME
    scope: instance
env:
  - name: HF_TOKEN
    description: HuggingFace token.
    required: false
    default: ""
gpu: required
"#;

#[test]
fn full_v2_manifest_round_trips() {
    let m = parse_manifest(FULL).expect("full manifest should parse");
    assert_eq!(m.id, "comfyui");
    assert_eq!(
        m.build
            .as_ref()
            .and_then(|b| b.args.as_ref())
            .and_then(|a| a.get("CUDA")),
        Some(&"12.4".to_string())
    );
    assert_eq!(
        m.ports[0],
        PortMapping {
            name: "ui".into(),
            container: 8188,
            host: Some(8188),
            protocol: Protocol::Tcp,
            web: true,
            path: "/".into(),
            description: Some("Web UI.".into()),
        }
    );
    // protocol/web/path defaults applied to the second port.
    assert_eq!(
        m.ports[1],
        PortMapping {
            name: "api".into(),
            container: 9000,
            host: None,
            protocol: Protocol::Udp,
            web: false,
            path: "/".into(),
            description: None,
        }
    );
    assert_eq!(
        m.mounts[0],
        MountMapping {
            name: "output".into(),
            target: "/app/output".into(),
            placement: Placement::Bind,
            description: None,
        }
    );
    assert_eq!(
        m.mounts[1],
        MountMapping {
            name: "models".into(),
            target: "/app/models".into(),
            placement: Placement::Volume,
            description: None,
        }
    );
    assert_eq!(
        m.cache,
        vec![
            CacheSpec::Venv,
            CacheSpec::Huggingface,
            CacheSpec::Custom {
                name: "torch".into(),
                env: "TORCH_HOME".into(),
                scope: CacheScope::Instance,
            },
        ]
    );
    assert_eq!(
        m.env[0],
        EnvSpec {
            name: "HF_TOKEN".into(),
            description: Some("HuggingFace token.".into()),
            required: false,
            default: Some("".into()),
        }
    );
    assert_eq!(m.gpu, GpuMode::Required);
}

#[test]
fn applies_defaults_to_a_minimal_build_recipe() {
    let m: Manifest = parse_manifest(
        "\nmanifestVersion: 2\nid: minimal\nname: Minimal\nversion: \"1.0\"\nbuild: {}\n",
    )
    .expect("minimal manifest should parse");
    assert_eq!(
        m.build.as_ref().map(|b| b.dockerfile.as_str()),
        Some("Dockerfile")
    );
    assert_eq!(m.gpu, GpuMode::Preferred);
    assert_eq!(m.ports, vec![]);
    assert_eq!(m.mounts, vec![]);
    assert_eq!(m.cache, vec![]);
    assert_eq!(m.env, vec![]);
    assert_eq!(m.image, None);
}

#[test]
fn accepts_an_image_based_recipe_no_build() {
    let m = parse_manifest(
        "\nmanifestVersion: 2\nid: ollama\nname: Ollama\nversion: \"0.6.0\"\nimage: ollama/ollama:0.6.0\ngpu: preferred\n",
    )
    .expect("image-based manifest should parse");
    assert_eq!(m.image.as_deref(), Some("ollama/ollama:0.6.0"));
    assert_eq!(m.build, None);
}

#[test]
fn rejects_a_recipe_with_neither_build_nor_image() {
    assert_rejects(
        "manifestVersion: 2\nid: x\nname: X\nversion: '1'",
        "build` or `image",
    );
}

#[test]
fn rejects_build_and_image_together() {
    assert_rejects(
        "manifestVersion: 2\nid: x\nname: X\nversion: '1'\nbuild: {}\nimage: nginx:alpine",
        "mutually exclusive",
    );
}

#[test]
fn rejects_wrong_manifest_version() {
    assert_rejects(
        "manifestVersion: 1\nid: x\nname: X\nversion: '1'\nbuild: {}",
        "manifestVersion",
    );
}

#[test]
fn rejects_bad_id() {
    assert_rejects(
        "manifestVersion: 2\nid: Bad_ID\nname: X\nversion: '1'\nbuild: {}",
        "id",
    );
}

#[test]
fn rejects_bad_gpu_mode() {
    assert_rejects(
        "manifestVersion: 2\nid: x\nname: X\nversion: '1'\nbuild: {}\ngpu: maybe",
        "gpu",
    );
}

#[test]
fn rejects_unknown_keys_strict() {
    // No substring — any rejection is enough (Zod strict / serde deny_unknown_fields).
    assert!(
        parse_manifest("manifestVersion: 2\nid: x\nname: X\nversion: '1'\nbuild: {}\ntypo: true")
            .is_err()
    );
}

#[test]
fn rejects_out_of_range_port() {
    assert_rejects(
        "manifestVersion: 2\nid: x\nname: X\nversion: '1'\nbuild: {}\nports:\n  - name: ui\n    container: 70000",
        "ports[0].container",
    );
}

#[test]
fn rejects_duplicate_port_names() {
    assert_rejects(
        "manifestVersion: 2\nid: x\nname: X\nversion: \"1\"\nbuild: {}\nports:\n  - name: ui\n    container: 80\n  - name: ui\n    container: 81\n",
        "duplicate ports entry \"ui\"",
    );
}

#[test]
fn rejects_duplicate_mount_names() {
    assert_rejects(
        "manifestVersion: 2\nid: x\nname: X\nversion: \"1\"\nbuild: {}\nmounts:\n  - name: data\n    target: /a\n  - name: data\n    target: /b\n",
        "duplicate mounts entry \"data\"",
    );
}

#[test]
fn rejects_a_duplicated_cache_preset() {
    assert_rejects(
        "manifestVersion: 2\nid: x\nname: X\nversion: \"1\"\nbuild: {}\ncache:\n  - type: venv\n  - type: venv\n",
        "duplicate cache entry \"venv\"",
    );
}

#[test]
fn allows_two_custom_caches_with_distinct_names() {
    let m = parse_manifest(
        "manifestVersion: 2\nid: x\nname: X\nversion: \"1\"\nbuild: {}\ncache:\n  - type: custom\n    name: a\n    env: A_HOME\n  - type: custom\n    name: b\n    env: B_HOME\n",
    )
    .expect("distinct custom caches should parse");
    assert_eq!(m.cache.len(), 2);
}

// Parity with the Zod `strictObject` per cache variant: an unknown key *inside*
// a cache entry must be rejected, not silently dropped. serde's internally-tagged
// enum can't express this, so the port hand-writes CacheSpec's Deserialize — these
// pin that strictness (not in the Deno suite, but required for spec parity).
#[test]
fn rejects_an_unknown_key_inside_a_preset_cache_entry() {
    assert!(
        parse_manifest(
            "manifestVersion: 2\nid: x\nname: X\nversion: \"1\"\nbuild: {}\ncache:\n  - type: venv\n    bogus: hello\n"
        )
        .is_err()
    );
}

#[test]
fn rejects_a_field_from_another_variant_on_a_preset_cache_entry() {
    // `name`/`env` belong to `custom`; on a preset they are unrecognized keys.
    assert!(
        parse_manifest(
            "manifestVersion: 2\nid: x\nname: X\nversion: \"1\"\nbuild: {}\ncache:\n  - type: venv\n    name: whatever\n"
        )
        .is_err()
    );
}

#[test]
fn rejects_an_unknown_key_inside_a_custom_cache_entry() {
    assert!(
        parse_manifest(
            "manifestVersion: 2\nid: x\nname: X\nversion: \"1\"\nbuild: {}\ncache:\n  - type: custom\n    name: a\n    env: A_HOME\n    EVIL: injection\n"
        )
        .is_err()
    );
}

#[test]
fn rejects_an_unknown_cache_type() {
    assert!(
        parse_manifest(
            "manifestVersion: 2\nid: x\nname: X\nversion: \"1\"\nbuild: {}\ncache:\n  - type: bogus\n"
        )
        .is_err()
    );
}

#[test]
fn rejects_a_mount_name_that_would_traverse_the_data_root() {
    assert_rejects(
        "manifestVersion: 2\nid: x\nname: X\nversion: \"1\"\nbuild: {}\nmounts:\n  - name: ../../etc\n    target: /data\n",
        "mounts[0].name",
    );
}

#[test]
fn rejects_a_non_absolute_mount_target() {
    assert_rejects(
        "manifestVersion: 2\nid: x\nname: X\nversion: '1'\nbuild: {}\nmounts:\n  - name: data\n    target: rel/path",
        "mounts[0].target",
    );
}

#[test]
fn rejects_an_invalid_env_var_name() {
    assert_rejects(
        "manifestVersion: 2\nid: x\nname: X\nversion: '1'\nbuild: {}\nenv:\n  - name: BAD-NAME",
        "env[0].name",
    );
}

#[test]
fn rejects_a_relative_ports_path() {
    assert_rejects(
        "manifestVersion: 2\nid: x\nname: X\nversion: '1'\nbuild: {}\nports:\n  - name: ui\n    container: 80\n    path: api/v1",
        "ports[0].path",
    );
}

#[test]
fn rejects_a_blank_name() {
    assert_rejects(
        "manifestVersion: 2\nid: x\nname: \"   \"\nversion: \"1\"\nbuild: {}",
        "name",
    );
}

#[test]
fn rejects_a_version_outside_the_image_tag_charset() {
    assert_rejects(
        "manifestVersion: 2\nid: x\nname: X\nversion: \"1 0/bad\"\nbuild: {}",
        "version",
    );
}

#[test]
fn rejects_an_image_reference_with_unsafe_characters() {
    assert_rejects(
        "manifestVersion: 2\nid: x\nname: X\nversion: \"1\"\nimage: \"bad image?x\"",
        "image",
    );
}

// Hardening beyond the Deno suite: the charsets are security guards (id/version/
// image reach Docker labels, filesystem paths, and the Engine HTTP request line).
// A JS `$` (no `m` flag) never matches before a trailing newline; Rust's regex `$`
// must behave the same, or an embedded/trailing newline would slip an injection
// past the charset. These pin that anchoring rather than trust the engine default.
#[test]
fn rejects_an_id_with_a_trailing_newline() {
    // YAML double-quoted `\n` decodes to a real newline appended to the id.
    assert_rejects(
        "manifestVersion: 2\nid: \"comfyui\\n\"\nname: X\nversion: \"1\"\nbuild: {}",
        "id",
    );
}

#[test]
fn rejects_an_image_ref_with_an_embedded_newline() {
    assert_rejects(
        "manifestVersion: 2\nid: x\nname: X\nversion: \"1\"\nimage: \"nginx\\nRUN evil\"",
        "image",
    );
}

#[test]
fn rejects_two_mounts_on_the_same_target() {
    assert_rejects(
        "manifestVersion: 2\nid: x\nname: X\nversion: \"1\"\nbuild: {}\nmounts:\n  - name: a\n    target: /data\n  - name: b\n    target: /data\n",
        "duplicate mount target",
    );
}

/// Regenerates the committed manifest JSON Schema for recipe authors/agents.
/// Deterministic (same types → same document), so a dirty `git diff` on
/// `spec/compositz.schema.json` after `cargo test` means the committed schema is
/// stale — the same generate-and-commit pattern as the desktop crate's
/// `export_bindings`.
#[test]
fn export_schema() {
    let schema = manifest_json_schema();
    let json = serde_json::to_string_pretty(schema.as_value()).expect("schema serializes");
    std::fs::write("../../spec/compositz.schema.json", format!("{json}\n"))
        .expect("write spec/compositz.schema.json");
}

#[test]
fn manifest_json_schema_describes_the_manifest() {
    // The schemars derive is the replacement for the Deno scripts/gen_schema.ts —
    // smoke-test that it produces a titled object schema over the manifest fields.
    let schema = manifest_json_schema();
    let value = schema.as_value();
    assert_eq!(
        value.get("title").and_then(|t| t.as_str()),
        Some("Compositz recipe manifest")
    );
    let props = value
        .get("properties")
        .and_then(|p| p.as_object())
        .expect("schema should expose object properties");
    for field in ["manifestVersion", "id", "name", "version", "ports", "gpu"] {
        assert!(props.contains_key(field), "schema missing property {field}");
    }
}

#[test]
fn custom_cache_requires_name_and_env() {
    // No substring — any rejection is enough (serde missing-field on the union).
    assert!(
        parse_manifest(
            "manifestVersion: 2\nid: x\nname: X\nversion: '1'\nbuild: {}\ncache:\n  - type: custom"
        )
        .is_err()
    );
}
