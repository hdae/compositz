//! Behavior tests for recipe-bundle ingestion, ported from
//! `packages/core/src/recipe/ingest_test.ts`. The `ingestGithub` network cases live
//! separately (Phase 1e-2, opt-in `COMPOSITZ_NET_TESTS`); everything here is offline.
//!
//! Like the Deno suite, malicious archives are built with a hand-rolled ustar writer
//! so we can craft entries (absolute / `..` / symlink / device) that a well-behaved
//! tar builder would refuse to emit.

use std::collections::BTreeMap;
use std::fs;
use std::io::{Cursor, Write};

use compositz_core::recipe::instance::{is_valid_instance_id, load_instance, load_instance_config};
use compositz_core::recipe::manifest::Placement;
use compositz_core::{
    BundleSource, IngestOpts, duplicate_instance, extract_archive_to, ingest_bundle,
    random_instance_id,
};
use tempfile::TempDir;

const MANIFEST: &str = "manifestVersion: 2\nid: hello\nname: Hello\nversion: \"0.1.0\"\nbuild: { dockerfile: Dockerfile }\ngpu: none\n";
const DOCKERFILE: &str = "FROM scratch\n";

// --- a hand-rolled ustar tar builder (parity with the Deno test helper) ------

struct TarEntry {
    path: String,
    data: Vec<u8>,
    typeflag: u8,
    linkname: String,
}

fn file_entry(path: &str, data: &str) -> TarEntry {
    TarEntry {
        path: path.to_string(),
        data: data.as_bytes().to_vec(),
        typeflag: b'0',
        linkname: String::new(),
    }
}

fn special_entry(path: &str, typeflag: u8, linkname: &str) -> TarEntry {
    TarEntry {
        path: path.to_string(),
        data: Vec::new(),
        typeflag,
        linkname: linkname.to_string(),
    }
}

fn tar_header(path: &str, size: usize, typeflag: u8, linkname: &str) -> [u8; 512] {
    let mut h = [0u8; 512];
    let put = |h: &mut [u8; 512], s: &[u8], off: usize, len: usize| {
        let n = s.len().min(len);
        h[off..off + n].copy_from_slice(&s[..n]);
    };
    put(&mut h, path.as_bytes(), 0, 100);
    put(&mut h, b"0000644\0", 100, 8); // mode
    put(&mut h, b"0000000\0", 108, 8); // uid
    put(&mut h, b"0000000\0", 116, 8); // gid
    put(&mut h, format!("{size:011o}\0").as_bytes(), 124, 12); // size (octal)
    put(&mut h, b"00000000000\0", 136, 12); // mtime
    for b in h.iter_mut().take(156).skip(148) {
        *b = 0x20; // checksum field = spaces while summing
    }
    h[156] = typeflag;
    put(&mut h, linkname.as_bytes(), 157, 100);
    put(&mut h, b"ustar\0", 257, 6);
    put(&mut h, b"00", 263, 2);
    let sum: u32 = h.iter().map(|&b| b as u32).sum();
    put(&mut h, format!("{sum:06o}\0 ").as_bytes(), 148, 8);
    h
}

fn make_tar(entries: &[TarEntry]) -> Vec<u8> {
    let mut out = Vec::new();
    for e in entries {
        out.extend_from_slice(&tar_header(&e.path, e.data.len(), e.typeflag, &e.linkname));
        if !e.data.is_empty() {
            let padded = e.data.len().div_ceil(512) * 512;
            let mut block = vec![0u8; padded];
            block[..e.data.len()].copy_from_slice(&e.data);
            out.extend_from_slice(&block);
        }
    }
    out.extend_from_slice(&[0u8; 1024]); // two trailing zero blocks
    out
}

fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    e.write_all(bytes).unwrap();
    e.finish().unwrap()
}

fn valid_tar() -> Vec<u8> {
    make_tar(&[
        file_entry("compositz.yaml", MANIFEST),
        file_entry("Dockerfile", DOCKERFILE),
    ])
}

fn archive(bytes: Vec<u8>) -> BundleSource {
    BundleSource::Archive {
        reader: Box::new(Cursor::new(bytes)),
        subdir: None,
    }
}

fn archive_sub(bytes: Vec<u8>, subdir: &str) -> BundleSource {
    BundleSource::Archive {
        reader: Box::new(Cursor::new(bytes)),
        subdir: Some(subdir.to_string()),
    }
}

fn store() -> TempDir {
    TempDir::new().unwrap()
}

fn s(dir: &TempDir) -> &str {
    dir.path().to_str().unwrap()
}

// --- happy paths -----------------------------------------------------------

#[test]
fn ingest_a_flat_tar_creates_an_instance_under_a_minted_id() {
    let store = store();
    let inst = ingest_bundle(archive(valid_tar()), s(&store), IngestOpts::default()).unwrap();

    assert!(inst.instance_id.starts_with("hello-"));
    let suffix = &inst.instance_id["hello-".len()..];
    assert_eq!(suffix.len(), 8);
    assert!(
        suffix
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    );
    assert_eq!(inst.app_id, "hello");
    assert_eq!(inst.manifest.name, "Hello");
    assert_eq!(inst.meta.source.as_deref(), Some("upload"));

    let reloaded = load_instance(store.path().join(&inst.instance_id).to_str().unwrap()).unwrap();
    assert_eq!(reloaded.manifest.id, "hello");
    assert!(
        store
            .path()
            .join(&inst.instance_id)
            .join("app")
            .join("Dockerfile")
            .is_file()
    );
}

#[test]
fn ingest_a_single_top_level_wrapper_dir_is_unwrapped() {
    let store = store();
    let tar = make_tar(&[
        file_entry("hello-recipe/compositz.yaml", MANIFEST),
        file_entry("hello-recipe/Dockerfile", DOCKERFILE),
    ]);
    let inst = ingest_bundle(archive(tar), s(&store), IngestOpts::default()).unwrap();
    assert_eq!(inst.app_id, "hello");
    assert!(
        store
            .path()
            .join(&inst.instance_id)
            .join("app/Dockerfile")
            .is_file()
    );
}

#[test]
fn ingest_gzip_is_auto_detected_by_magic_bytes() {
    let store = store();
    let inst = ingest_bundle(
        archive(gzip(&valid_tar())),
        s(&store),
        IngestOpts::default(),
    )
    .unwrap();
    assert_eq!(inst.app_id, "hello");
}

#[test]
fn ingest_a_local_directory_source_is_copied_in() {
    let store = store();
    let src = TempDir::new().unwrap();
    fs::write(src.path().join("compositz.yaml"), MANIFEST).unwrap();
    fs::write(src.path().join("Dockerfile"), DOCKERFILE).unwrap();
    let inst = ingest_bundle(
        BundleSource::Dir {
            dir: src.path().to_str().unwrap().to_string(),
        },
        s(&store),
        IngestOpts::default(),
    )
    .unwrap();
    assert_eq!(inst.app_id, "hello");
    assert!(inst.meta.source.unwrap().contains("dir:"));
}

#[test]
fn duplicate_copies_only_app_and_mints_a_new_id() {
    let store = store();
    let a = ingest_bundle(archive(valid_tar()), s(&store), IngestOpts::default()).unwrap();
    let b = duplicate_instance(s(&store), &a.instance_id).unwrap();
    assert_eq!(b.app_id, "hello");
    assert_ne!(b.instance_id, a.instance_id);
    assert_eq!(
        b.meta.source.as_deref(),
        Some(&*format!("duplicate:{}", a.instance_id))
    );
    assert!(
        store
            .path()
            .join(&b.instance_id)
            .join("app/Dockerfile")
            .is_file()
    );
}

#[test]
fn duplicate_does_not_carry_over_data_launch_state_or_ports() {
    let store = store();
    let a = ingest_bundle(archive(valid_tar()), s(&store), IngestOpts::default()).unwrap();
    let a_dir = store.path().join(&a.instance_id);
    // Per-instance state next to app/: a ports-only override + launch snapshot + data.
    fs::write(a_dir.join("config.yaml"), "hostPorts:\n  web: 9999\n").unwrap();
    fs::write(a_dir.join(".launched.yaml"), "env: {}\n").unwrap();
    fs::create_dir(a_dir.join("data")).unwrap();
    fs::write(a_dir.join("data/output.txt"), "secret").unwrap();

    let b = duplicate_instance(s(&store), &a.instance_id).unwrap();
    let b_dir = store.path().join(&b.instance_id);
    assert!(b_dir.join("app/Dockerfile").is_file());
    // A hostPorts-only override inherits as NOTHING (no config.yaml at all), and
    // data / launch snapshot never carry over.
    assert!(!b_dir.join("config.yaml").exists());
    assert!(!b_dir.join(".launched.yaml").exists());
    assert!(!b_dir.join("data").exists());
}

#[test]
fn duplicate_inherits_the_settings_override_minus_host_ports() {
    let store = store();
    let a = ingest_bundle(archive(valid_tar()), s(&store), IngestOpts::default()).unwrap();
    fs::write(
        store.path().join(&a.instance_id).join("config.yaml"),
        "hostPorts:\n  web: 9999\nenv:\n  TOKEN: sekrit\nplacement:\n  models: bind\n",
    )
    .unwrap();
    let b = duplicate_instance(s(&store), &a.instance_id).unwrap();
    let cfg = load_instance_config(store.path().join(&b.instance_id).to_str().unwrap()).unwrap();
    assert_eq!(
        cfg.env,
        Some(BTreeMap::from([(
            "TOKEN".to_string(),
            "sekrit".to_string()
        )]))
    );
    assert_eq!(
        cfg.placement,
        Some(BTreeMap::from([("models".to_string(), Placement::Bind)]))
    );
    assert_eq!(cfg.host_ports, None);
}

// --- subdir descent (GitHub monorepo, RI-3) --------------------------------

#[test]
fn ingest_a_subdir_descends_into_a_codeload_style_wrapper() {
    let store = store();
    let tar = make_tar(&[
        file_entry("repo-main/README.md", "top-level noise"),
        file_entry("repo-main/recipes/hello/compositz.yaml", MANIFEST),
        file_entry("repo-main/recipes/hello/Dockerfile", DOCKERFILE),
    ]);
    let inst = ingest_bundle(
        archive_sub(tar, "recipes/hello"),
        s(&store),
        IngestOpts::default(),
    )
    .unwrap();
    assert_eq!(inst.app_id, "hello");
    assert!(
        store
            .path()
            .join(&inst.instance_id)
            .join("app/Dockerfile")
            .is_file()
    );
}

#[test]
fn ingest_a_subdir_works_without_a_top_level_wrapper_dir_too() {
    let store = store();
    let tar = make_tar(&[
        file_entry("recipes/hello/compositz.yaml", MANIFEST),
        file_entry("recipes/hello/Dockerfile", DOCKERFILE),
    ]);
    let inst = ingest_bundle(
        archive_sub(tar, "recipes/hello"),
        s(&store),
        IngestOpts::default(),
    )
    .unwrap();
    assert_eq!(inst.app_id, "hello");
}

#[test]
fn ingest_a_subdir_with_no_manifest_is_rejected_naming_the_subdir() {
    let store = store();
    let tar = make_tar(&[
        file_entry("repo-main/recipes/hello/compositz.yaml", MANIFEST),
        file_entry("repo-main/recipes/hello/Dockerfile", DOCKERFILE),
    ]);
    let err = ingest_bundle(
        archive_sub(tar, "recipes/missing"),
        s(&store),
        IngestOpts::default(),
    )
    .unwrap_err();
    assert!(
        err.to_string().contains("under \"recipes/missing\""),
        "got: {err}"
    );
}

#[test]
fn ingest_a_subdir_that_escapes_the_bundle_is_rejected() {
    let store = store();
    let tar = make_tar(&[file_entry("repo-main/compositz.yaml", MANIFEST)]);
    let err = ingest_bundle(
        archive_sub(tar, "../escape"),
        s(&store),
        IngestOpts::default(),
    )
    .unwrap_err();
    assert!(
        err.to_string().contains("must be a path inside the bundle"),
        "got: {err}"
    );
}

// --- security: extraction refuses to escape the destination ----------------

fn assert_extract_err(bytes: Vec<u8>, needle: &str) {
    let dir = TempDir::new().unwrap();
    let err = extract_archive_to(Cursor::new(bytes), dir.path()).unwrap_err();
    assert!(err.to_string().contains(needle), "got: {err}");
}

#[test]
fn extract_rejects_a_dotdot_traversal_path() {
    let dir = TempDir::new().unwrap();
    let tar = make_tar(&[file_entry("../escape.txt", "pwned")]);
    let err = extract_archive_to(Cursor::new(tar), dir.path()).unwrap_err();
    assert!(err.to_string().contains("escapes the bundle"), "got: {err}");
    assert!(!dir.path().join("../escape.txt").exists());
}

#[test]
fn extract_rejects_an_absolute_path() {
    assert_extract_err(
        make_tar(&[file_entry("/tmp/compositz-escape.txt", "pwned")]),
        "escapes the bundle",
    );
}

#[test]
fn extract_rejects_a_symlink_entry() {
    assert_extract_err(
        make_tar(&[special_entry("link", b'2', "/etc/passwd")]),
        "symlinks",
    );
}

#[test]
fn extract_rejects_a_hardlink_entry() {
    assert_extract_err(
        make_tar(&[special_entry("hard", b'1', "secret")]),
        "hardlinks",
    );
}

#[test]
fn extract_rejects_a_device_node_entry() {
    assert_extract_err(make_tar(&[special_entry("dev", b'3', "")]), "devices");
}

#[test]
fn extract_rejects_a_deeply_nested_path_that_escapes_after_normalize() {
    // normalizes to ../escape.txt
    assert_extract_err(
        make_tar(&[file_entry("subdir/../../escape.txt", "pwned")]),
        "escapes the bundle",
    );
}

#[test]
fn extract_rejects_traversal_inside_a_gzip_archive_too() {
    assert_extract_err(
        gzip(&make_tar(&[file_entry("../escape.txt", "pwned")])),
        "escapes the bundle",
    );
}

#[test]
fn extract_a_path_that_normalizes_back_inside_the_root_is_allowed() {
    let dir = TempDir::new().unwrap();
    // a/../b.txt normalizes to b.txt — legitimate, must NOT be rejected.
    extract_archive_to(
        Cursor::new(make_tar(&[file_entry("a/../b.txt", "ok")])),
        dir.path(),
    )
    .unwrap();
    assert_eq!(fs::read_to_string(dir.path().join("b.txt")).unwrap(), "ok");
}

#[test]
fn extract_an_empty_name_entry_is_skipped_not_fatal() {
    let dir = TempDir::new().unwrap();
    let tar = make_tar(&[file_entry("", "x"), file_entry("real.txt", "ok")]);
    extract_archive_to(Cursor::new(tar), dir.path()).unwrap();
    assert_eq!(
        fs::read_to_string(dir.path().join("real.txt")).unwrap(),
        "ok"
    );
}

// --- structural rejection --------------------------------------------------

#[test]
fn ingest_a_bundle_with_no_manifest_is_rejected() {
    let store = store();
    let tar = make_tar(&[file_entry("README.md", "hi")]);
    let err = ingest_bundle(archive(tar), s(&store), IngestOpts::default()).unwrap_err();
    assert!(err.to_string().contains("no compositz.yaml"), "got: {err}");
}

#[test]
fn ingest_a_bundle_with_two_top_level_manifests_is_ambiguous() {
    let store = store();
    let tar = make_tar(&[
        file_entry("a/compositz.yaml", MANIFEST),
        file_entry("a/Dockerfile", DOCKERFILE),
        file_entry("b/compositz.yaml", MANIFEST),
        file_entry("b/Dockerfile", DOCKERFILE),
    ]);
    let err = ingest_bundle(archive(tar), s(&store), IngestOpts::default()).unwrap_err();
    assert!(err.to_string().contains("ambiguous"), "got: {err}");
}

#[test]
fn ingest_an_invalid_manifest_is_rejected() {
    let store = store();
    let tar = make_tar(&[file_entry(
        "compositz.yaml",
        "manifestVersion: 2\nid: BAD_CAPS\n",
    )]);
    assert!(ingest_bundle(archive(tar), s(&store), IngestOpts::default()).is_err());
}

// --- id minting ------------------------------------------------------------

#[test]
fn random_instance_id_is_app_dash_rand_and_well_distributed() {
    let id = random_instance_id("comfyui");
    assert!(id.starts_with("comfyui-"));
    assert!(is_valid_instance_id(&id));
    // 50 draws are all well-formed and all distinct — a constant-returning bug
    // (e.g. a broken RNG) collapses the set to size 1 and fails deterministically.
    let draws: Vec<String> = (0..50).map(|_| random_instance_id("x")).collect();
    for d in &draws {
        assert!(d.starts_with("x-"));
        assert_eq!(d["x-".len()..].len(), 8);
    }
    assert_eq!(
        draws.iter().collect::<std::collections::HashSet<_>>().len(),
        50
    );
}

#[test]
fn instance_id_pattern_accepts_minted_ids_rejects_path_shaped_ids() {
    for ok in ["hello-web-a1b2c3", "x-00000000", "comfyui"] {
        assert!(is_valid_instance_id(ok), "should accept {ok:?}");
    }
    for bad in ["../other", "a/b", "UPPER", ".", "", "a\\b", "foo/../bar"] {
        assert!(!is_valid_instance_id(bad), "should reject {bad:?}");
    }
}
