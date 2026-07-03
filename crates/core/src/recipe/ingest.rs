//! Ingest a recipe bundle into the instance store (ADR-017): extract → validate →
//! mint an `instanceId` → create `<instancesDir>/<instanceId>/app/`. Sources are a
//! tar / tar.gz archive byte stream (a UI upload, a CLI file, or a GitHub codeload
//! tarball) or a local directory. Building the image stays the separate Install step.
//!
//! Ported from `packages/core/src/recipe/ingest.ts`. The archive is extracted
//! STREAMING — each entry is written to disk as it is read — so an arbitrarily
//! large bundle never buffers in RAM, and there is no size cap (the manager is
//! trusted and recipes come from the user; resource-exhaustion "bombs" are out of
//! scope per the threat model). The archive format is tar / tar.gz ONLY, matching
//! the Deno source (there is no zip path).
//!
//! SECURITY (extract safely, regardless of size): archive entry paths are
//! UNTRUSTED. Extraction rejects absolute paths, `..` traversal (after lexical
//! normalization, so a legitimate `a/../b` still resolves inside), and
//! symlink/hardlink/device entries — a bundle must not write outside the staging
//! directory or plant a link. The subdir descent (`safe_rel_subdir`) is the same
//! boundary for the GitHub monorepo case (the ★ hardening flagged in Phase 1d).

use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};

use flate2::read::MultiGzDecoder;
use tar::EntryType;
use tempfile::Builder;

use crate::Error;
use crate::brand;
use crate::recipe::config::Override;
use crate::recipe::instance::{
    APP_SUBDIR, Instance, InstanceMeta, META_FILE, is_valid_instance_id, load_instance,
    load_instance_config, save_instance_config, write_meta,
};
use crate::recipe::loader::load_recipe;
use crate::recipe::norm_dir;

/// The random-suffix alphabet, matching the Deno `ID_ALPHABET`.
const ID_ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";

/// A recipe bundle to ingest: a packed-archive byte reader, or a directory on disk.
///
/// The archive variant carries a boxed reader rather than the Deno `ReadableStream`;
/// extraction is synchronous (tar-rs), so async callers wrap the whole ingest in
/// `spawn_blocking` and build the reader inside (a file handle, or a blocking
/// `reqwest` response for GitHub).
pub enum BundleSource {
    Archive {
        reader: Box<dyn Read + Send>,
        /// Narrow ingestion to this path inside the bundle (a GitHub monorepo subdir).
        subdir: Option<String>,
    },
    Dir {
        dir: String,
    },
}

/// Provenance overrides for an ingest — mirrors the Deno `opts`. Both default:
/// `source` to a description of the [`BundleSource`], `created_at` to now (ISO-8601).
#[derive(Debug, Default, Clone)]
pub struct IngestOpts {
    pub source: Option<String>,
    pub created_at: Option<String>,
}

/// Mint an opaque, legible instance id `<appId>-<rand>`. The random suffix is a
/// collision-avoidance tag, NOT a security token — modulo bias on 36 symbols is
/// irrelevant for a 36^8 opaque key. Uses the OS CSPRNG (parity with
/// `crypto.getRandomValues`).
pub fn random_instance_id(app_id: &str) -> String {
    random_instance_id_sized(app_id, 8)
}

fn random_instance_id_sized(app_id: &str, size: usize) -> String {
    let mut bytes = vec![0u8; size];
    getrandom::getrandom(&mut bytes).expect("OS CSPRNG unavailable");
    let suffix: String = bytes
        .iter()
        .map(|b| ID_ALPHABET[*b as usize % ID_ALPHABET.len()] as char)
        .collect();
    format!("{app_id}-{suffix}")
}

/// Ingest a bundle and create a new instance. Staging happens INSIDE `instancesDir`
/// (same filesystem) so the final move is an atomic rename. The new instance id is
/// random, so this never overwrites an existing instance.
pub fn ingest_bundle(
    source: BundleSource,
    instances_dir: &str,
    opts: IngestOpts,
) -> Result<Instance, Error> {
    let instances_dir = norm_dir(instances_dir);
    fs::create_dir_all(&instances_dir)?;
    // RAII-cleaned staging dir; dot-prefixed so `list_instances` skips it. tempfile
    // ignores drop-time removal errors, so a staging dir renamed away (the flat-tar
    // case, where the bundle root IS the staging dir) cleans up without complaint.
    let staging = Builder::new()
        .prefix(".ingest-")
        .tempdir_in(&instances_dir)?;

    let described = describe_source(&source);
    let subdir = match &source {
        BundleSource::Archive { subdir, .. } => subdir.clone(),
        BundleSource::Dir { .. } => None,
    };

    match source {
        BundleSource::Archive { reader, .. } => extract_archive_to(reader, staging.path())?,
        BundleSource::Dir { dir } => copy_tree_to(Path::new(&dir), staging.path())?,
    }

    let bundle_root = locate_bundle_root(staging.path(), subdir.as_deref())?;
    let manifest = load_recipe(bundle_root.to_str().ok_or_else(non_utf8)?)?.manifest;
    let instance_id = random_instance_id(&manifest.id);

    let final_dir = Path::new(&instances_dir).join(&instance_id);
    if final_dir.exists() {
        return Err(Error::Instance(format!(
            "instance \"{instance_id}\" already exists"
        )));
    }

    // Assemble the COMPLETE instance (app/ + meta.json) in a dot-prefixed publish
    // dir, then publish with ONE atomic rename — so a concurrent list_instances
    // never sees a half-built (meta-less ghost) instance, and a pre-publish failure
    // leaves no orphan (the RAII guard removes it).
    let publish = Builder::new().prefix(".pub-").tempdir_in(&instances_dir)?;
    fs::rename(&bundle_root, publish.path().join(APP_SUBDIR))?;
    let meta = InstanceMeta {
        source: Some(opts.source.unwrap_or(described)),
        created_at: Some(opts.created_at.unwrap_or_else(now_iso8601)),
    };
    write_meta(
        publish
            .path()
            .join(META_FILE)
            .to_str()
            .ok_or_else(non_utf8)?,
        &meta,
    )?;
    fs::rename(publish.path(), &final_dir)?; // atomic publish

    // final_dir is now a complete, valid instance; a transient re-read failure here
    // must NOT delete it (that would be irreversible data loss). The RAII guards
    // hold their now-moved paths, so neither can touch final_dir.
    load_instance(final_dir.to_str().ok_or_else(non_utf8)?)
}

/// Duplicate an instance into a new one: copies the `app/` bundle plus the Settings
/// override (env values, placement — "another copy of this app as I configured it"),
/// never the persistent data (volumes / data-root start empty). `hostPorts` are
/// DROPPED from the inherited override: a copy must claim its own ports — callers
/// deconflict against the definitions right after (`deconflict_host_ports`).
pub fn duplicate_instance(instances_dir: &str, src_instance_id: &str) -> Result<Instance, Error> {
    // Validate the source id HERE, not only at callers (mirrors `remove_instance_dir`,
    // ADR-025): `src_instance_id` is joined into a filesystem path below, so a
    // path-shaped id (`.`, `..`, `a/b`, `a\b`) must never reach the join — that would
    // read a directory OUTSIDE the store (cross-instance disclosure). The one core
    // path-touching duplicate/copy sink is now self-defending, like the delete sink.
    if !is_valid_instance_id(src_instance_id) {
        return Err(Error::Instance(format!(
            "invalid instance id: \"{src_instance_id}\""
        )));
    }
    let instances_dir = norm_dir(instances_dir);
    let src_dir = Path::new(&instances_dir).join(src_instance_id);
    let src_app = src_dir.join(APP_SUBDIR);
    // Validates the source is a real instance.
    let id = load_recipe(src_app.to_str().ok_or_else(non_utf8)?)?
        .manifest
        .id;
    let src_override = load_instance_config(src_dir.to_str().ok_or_else(non_utf8)?)?;
    let inherited = Override {
        host_ports: None,
        ..src_override
    };

    let instance_id = random_instance_id(&id);
    let final_dir = Path::new(&instances_dir).join(&instance_id);
    if final_dir.exists() {
        return Err(Error::Instance(format!(
            "instance \"{instance_id}\" already exists"
        )));
    }

    // Stage the copy, then publish with one atomic rename — so a concurrent
    // list_instances never sees a half-copied bundle, and a failed copy leaves no
    // orphan (same-fs staging dir, like ingest_bundle).
    let staging = Builder::new().prefix(".dup-").tempdir_in(&instances_dir)?;
    copy_tree_to(&src_app, &staging.path().join(APP_SUBDIR))?;
    let meta = InstanceMeta {
        source: Some(format!("duplicate:{src_instance_id}")),
        created_at: Some(now_iso8601()),
    };
    write_meta(
        staging
            .path()
            .join(META_FILE)
            .to_str()
            .ok_or_else(non_utf8)?,
        &meta,
    )?;
    if inherited.env.is_some() || inherited.placement.is_some() {
        save_instance_config(staging.path().to_str().ok_or_else(non_utf8)?, &inherited)?;
    }
    fs::rename(staging.path(), &final_dir)?;
    load_instance(final_dir.to_str().ok_or_else(non_utf8)?)
}

// --- extraction ------------------------------------------------------------

/// Securely expand a tar / tar.gz BYTE READER into `dest_dir`, writing each entry
/// to disk as it streams (so an arbitrarily large bundle never buffers in RAM).
/// Gzip is auto-detected by magic bytes. Entry paths are sanitized (no
/// absolute/`..`/escape) and symlink/hardlink/device entries are refused.
pub fn extract_archive_to(reader: impl Read, dest_dir: &Path) -> Result<(), Error> {
    let mut reader = reader;
    // Peek the first 2 bytes; gunzip when they are the gzip magic, else pass through.
    let mut head = [0u8; 2];
    let n = read_up_to(&mut reader, &mut head)?;
    let combined = io::Cursor::new(head[..n].to_vec()).chain(reader);
    if n == 2 && head[0] == 0x1f && head[1] == 0x8b {
        untar(MultiGzDecoder::new(combined), dest_dir)
    } else {
        untar(combined, dest_dir)
    }
}

/// Iterate a tar stream, writing each safe entry under `dest`.
fn untar(reader: impl Read, dest: &Path) -> Result<(), Error> {
    let mut archive = tar::Archive::new(reader);
    for entry in archive.entries()? {
        let mut entry = entry?;
        let entry_type = entry.header().entry_type();
        // Refuse links and devices before touching any path.
        if is_link_or_device(entry_type) {
            let path = entry_path_string(&entry);
            return Err(Error::Recipe(format!(
                "refusing archive entry \"{path}\": symlinks, hardlinks and devices are not allowed"
            )));
        }

        let raw = entry_path_string(&entry);
        // Skip the archive root / empty-name entries (they normalize to "." and
        // resolve to dest itself, which is not a file to write).
        let rel = normalize_posix(&raw.replace('\\', "/"));
        if rel == "." || rel.is_empty() {
            continue;
        }

        let target = safe_join(dest, &raw)?;
        if entry_type.is_dir() || raw.ends_with('/') {
            fs::create_dir_all(&target)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = File::create(&target)?;
        io::copy(&mut entry, &mut file)?;
    }
    Ok(())
}

/// A hardlink (`Link`), symlink, or device node (char / block / fifo) — never
/// materialized (they could point outside the bundle or be surprising to plant).
fn is_link_or_device(t: EntryType) -> bool {
    matches!(
        t,
        EntryType::Link | EntryType::Symlink | EntryType::Char | EntryType::Block | EntryType::Fifo
    )
}

/// The entry's stored path as a forward-slash string (lossy for non-UTF-8 names —
/// only used for messages and, via [`safe_join`], re-validated before any write).
fn entry_path_string(entry: &tar::Entry<'_, impl Read>) -> String {
    match entry.path() {
        Ok(path) => path.to_string_lossy().replace('\\', "/"),
        // A header path that won't parse can't name a safe target — surface it raw.
        Err(_) => String::from_utf8_lossy(&entry.path_bytes()).into_owned(),
    }
}

/// Resolve an untrusted archive path under `dest`, refusing anything that would
/// escape it: absolute, a `..` segment after lexical normalization, or a joined
/// path that is not contained by `dest`.
fn safe_join(dest: &Path, entry_path: &str) -> Result<PathBuf, Error> {
    let norm = normalize_posix(&entry_path.replace('\\', "/"));
    let escapes = || {
        Error::Recipe(format!(
            "refusing archive entry \"{entry_path}\": path escapes the bundle"
        ))
    };
    if norm.starts_with('/') || norm.split('/').any(|seg| seg == "..") {
        return Err(escapes());
    }
    let target = dest.join(&norm);
    // Defense in depth: after a clean normalize the join is guaranteed inside dest,
    // but re-assert it structurally so a normalize regression can never escape.
    if target
        .components()
        .any(|c| matches!(c, Component::ParentDir))
        || !target.starts_with(dest)
    {
        return Err(escapes());
    }
    Ok(target)
}

/// Recursively copy a directory tree, skipping symlinks (never follow out of tree).
fn copy_tree_to(src: &Path, dest: &Path) -> Result<(), Error> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        // `file_type` is `lstat`-based — a symlink reports as a symlink, not its
        // target, so it is skipped rather than followed out of the tree.
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        let from = entry.path();
        let to = dest.join(entry.file_name());
        if file_type.is_dir() {
            copy_tree_to(&from, &to)?;
        } else if file_type.is_file() {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Find the bundle root in a staging dir: the directory holding `compositz.yaml`,
/// at the root or in a single top-level wrapper dir (a `tar czf` of a directory, or
/// a GitHub codeload tarball `<repo>-<ref>/…`). When `subdir` is given, descend
/// into it under each candidate root first. Zero or multiple matches are
/// ambiguous → reject.
fn locate_bundle_root(staging: &Path, subdir: Option<&str>) -> Result<PathBuf, Error> {
    let manifest = brand::MANIFEST_FILE;
    let sub = match subdir {
        Some(s) => safe_rel_subdir(s)?,
        None => String::new(),
    };
    let root_of = |base: &Path| -> PathBuf {
        if sub.is_empty() {
            base.to_path_buf()
        } else {
            base.join(&sub)
        }
    };

    // 1. Manifest directly under the staging root (a bundle packed without a wrapper).
    let direct = root_of(staging);
    if direct.join(manifest).exists() {
        return Ok(direct);
    }

    // 2. Otherwise a single top-level wrapper dir, descended into `subdir` when given.
    let mut candidates: Vec<PathBuf> = Vec::new();
    for entry in fs::read_dir(staging)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let root = root_of(&entry.path());
        if root.join(manifest).exists() {
            candidates.push(root);
        }
    }
    match candidates.len() {
        1 => Ok(candidates.into_iter().next().unwrap()),
        0 => Err(Error::Recipe(if sub.is_empty() {
            format!(
                "no {manifest} found in the bundle (expected at the root or in a single top-level directory)"
            )
        } else {
            format!(
                "no {manifest} found under \"{sub}\" in the bundle (checked the root and each top-level directory)"
            )
        })),
        _ => Err(Error::Recipe(format!(
            "ambiguous bundle: {manifest} found in multiple top-level directories"
        ))),
    }
}

/// Validate an untrusted subdir is a relative path that stays inside the bundle,
/// and return it normalized (forward slashes, no trailing slash). Empty / "." ⇒ "".
///
/// This is the ★ boundary flagged in Phase 1d: the GitHub spec parser is
/// deliberately lenient on `subdir` (it splits only on `/`, so `a\..\b` reaches
/// here intact) — the real defense is HERE, replacing `\` with `/` first so a
/// Windows-style traversal can't slip through, then rejecting absolute / `..`.
fn safe_rel_subdir(subdir: &str) -> Result<String, Error> {
    let norm = normalize_posix(&subdir.replace('\\', "/"));
    let norm = norm.trim_end_matches('/');
    if norm.is_empty() || norm == "." {
        return Ok(String::new());
    }
    if norm.starts_with('/') || norm.split('/').any(|seg| seg == "..") {
        return Err(Error::Recipe(format!(
            "invalid subdir \"{subdir}\": must be a path inside the bundle"
        )));
    }
    Ok(norm.to_string())
}

/// POSIX lexical path normalization matching Deno `@std/path` `normalize` for
/// forward-slash input: collapse `.` / `//` and resolve `..` lexically (a leading
/// `..` is preserved for relative paths, dropped at an absolute root); a leading
/// `/` and a trailing `/` are preserved; empty ⇒ ".". No filesystem access, so it
/// never follows a symlink. Verified byte-for-byte against `@std/path` for a
/// traversal corpus (see the unit tests).
fn normalize_posix(path: &str) -> String {
    let is_abs = path.starts_with('/');
    let had_trailing = path.len() > 1 && path.ends_with('/');
    let mut out: Vec<&str> = Vec::new();
    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            ".." => match out.last() {
                Some(&last) if last != ".." => {
                    out.pop();
                }
                Some(_) => out.push(".."),
                None => {
                    if !is_abs {
                        out.push("..");
                    }
                }
            },
            seg => out.push(seg),
        }
    }
    let mut core = out.join("/");
    if is_abs {
        core = format!("/{core}");
    } else if core.is_empty() {
        core = ".".to_string();
    }
    if had_trailing && core != "." && !core.ends_with('/') {
        core.push('/');
    }
    core
}

/// Read up to `buf.len()` bytes, looping over short reads until the buffer is full
/// or EOF. Returns the number of bytes read (used to peek the gzip magic).
fn read_up_to(reader: &mut impl Read, buf: &mut [u8]) -> Result<usize, Error> {
    let mut filled = 0;
    while filled < buf.len() {
        let n = reader.read(&mut buf[filled..])?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    Ok(filled)
}

fn describe_source(source: &BundleSource) -> String {
    match source {
        BundleSource::Archive { .. } => "upload".to_string(),
        BundleSource::Dir { dir } => format!("dir:{dir}"),
    }
}

/// Current UTC time as an ISO-8601 string (`…Z`), the `meta.json` `createdAt`
/// default — mirrors the Deno `new Date().toISOString()`.
fn now_iso8601() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn non_utf8() -> Error {
    Error::Instance("instance path is not valid UTF-8".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Byte-for-byte truth table generated from Deno `@std/path` `normalize` (POSIX,
    // the server runtime) — the security boundary for `safe_join` / `safe_rel_subdir`
    // rests on this matching exactly. Regenerate with `scripts`-style deno if the
    // path lib is ever swapped; a drift here is a traversal risk, not a cosmetic one.
    #[test]
    fn normalize_posix_matches_std_path() {
        let cases = [
            ("", "."),
            (".", "."),
            ("..", ".."),
            ("a", "a"),
            ("a/b", "a/b"),
            ("a/b/", "a/b/"),
            ("a//b", "a/b"),
            ("a/./b", "a/b"),
            ("a/../b", "b"),
            ("a/b/../c", "a/c"),
            ("a/../b.txt", "b.txt"),
            ("a/..", "."),
            ("a/../..", ".."),
            ("subdir/../../escape.txt", "../escape.txt"),
            ("../escape", "../escape"),
            ("../escape.txt", "../escape.txt"),
            ("./a", "a"),
            ("/tmp/x", "/tmp/x"),
            ("/a/../b", "/b"),
            ("/..", "/"),
            ("/../..", "/"),
            ("recipes/hello", "recipes/hello"),
            ("recipes/hello/", "recipes/hello/"),
            ("foo/../bar", "bar"),
            ("a/b/c/../../d", "a/d"),
            ("x/y/../../../z", "../z"),
            ("C:/evil", "C:/evil"),
            ("..%2f..", "..%2f.."),
            ("a/./../b", "b"),
        ];
        for (input, expected) in cases {
            assert_eq!(normalize_posix(input), expected, "normalize({input:?})");
        }
    }

    // The subdir hardening (★ Phase-1d flag): a Windows-style backslash traversal
    // that ESCAPES must be rejected, and it only can be if the `\`→`/` replace runs
    // BEFORE the `..` check — otherwise `..\..\escape` is one `/`-free segment that
    // slips through, then the Windows OS reads `\` as a separator and traverses out.
    #[test]
    fn safe_rel_subdir_blocks_escaping_backslash_and_absolute_traversal() {
        // Genuine escapes — must error.
        assert!(safe_rel_subdir("..\\escape").is_err());
        assert!(safe_rel_subdir("a\\..\\..\\escape").is_err());
        assert!(safe_rel_subdir("../escape").is_err());
        assert!(safe_rel_subdir("/abs").is_err());
        assert!(safe_rel_subdir("a/../../b").is_err());
        // NOT escapes — the `..` cancels within the path, staying inside. Backslash
        // is normalized to `/`; the result is a legitimate relative subpath.
        assert_eq!(safe_rel_subdir("a\\..\\b").unwrap(), "b");
        assert_eq!(safe_rel_subdir("").unwrap(), "");
        assert_eq!(safe_rel_subdir(".").unwrap(), "");
        assert_eq!(safe_rel_subdir("recipes/hello/").unwrap(), "recipes/hello");
        assert_eq!(safe_rel_subdir("a/./b").unwrap(), "a/b");
    }
}
