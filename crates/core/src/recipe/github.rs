//! Ingest a recipe straight from GitHub (ADR-014, RI-3): the codeload tarball over
//! HTTPS, no `git` binary, public repos only (private-repo auth deferred). Ported
//! from `packages/core/src/recipe/github.ts`.
//!
//! This sub-step (1d) ports the PURE spec layer — the `owner/repo[/subdir][@ref]`
//! grammar (ADR-021), the codeload URL builder, and the provenance round-trip. The
//! download glue `ingestGithub` (fetch → `ingestBundle`) lands in 1e together with
//! `ingest_bundle`: it is only a pipe into it, and both codeload network tests
//! exercise the full download → gunzip → untar → locate pipeline (neither passes
//! without ingestion), so the transport half is built and tested as one unit there.
//!
//! GRAMMAR (ADR-021, amends ADR-014's `owner/repo[@ref][/subdir]`):
//!
//! ```text
//! owner/repo[/subdir][@ref]
//! ```
//!
//! The ref is delimited LAST by `@`, so it MAY itself contain `/` (e.g.
//! `@releases/v1` — a real long-lived branch shape); the subdir sits between repo
//! and `@ref`. Putting the subdir BEFORE the ref keeps the grammar unambiguous: a
//! slashed branch name and a subdir coexist without the parser guessing where one
//! ends. An optional `github:` scheme prefix is accepted (it mirrors `meta.source`).

use std::sync::LazyLock;
use std::time::Duration;

use crate::Error;
use crate::recipe::ingest::{BundleSource, IngestOpts, ingest_bundle};
use crate::recipe::instance::Instance;
use regex::Regex;

/// Optional scheme prefix; also the prefix [`github_source`] emits for provenance.
const GITHUB_SCHEME: &str = "github:";

/// GitHub login: alphanumeric + hyphen, no leading hyphen, ≤39 chars.
static OWNER_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9-]{0,38}$").unwrap());
/// GitHub repo name: alphanumeric plus `.`, `_`, `-`, 1–100 chars.
static REPO_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9._-]{1,100}$").unwrap());

/// A parsed GitHub source: `owner/repo[/subdir][@ref]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubSpec {
    pub owner: String,
    pub repo: String,
    /// Path inside the repo to the recipe directory (a monorepo subdir).
    pub subdir: Option<String>,
    /// Git ref — branch / tag / commit SHA. `None` ⇒ the repo's default branch.
    /// (`ref` is a Rust keyword, hence `git_ref`.)
    pub git_ref: Option<String>,
}

/// Parse `owner/repo[/subdir][@ref]` (optional `github:` prefix) into a
/// [`GithubSpec`]. Pure — no I/O. Returns [`Error::Github`] on a malformed spec.
pub fn parse_github_spec(input: &str) -> Result<GithubSpec, Error> {
    let mut rest = input.trim();
    // Strip an optional, case-insensitive `github:` scheme prefix. `get(..len)` is
    // bounds- and char-boundary-safe (returns `None` rather than panicking).
    if let Some(prefix) = rest.get(..GITHUB_SCHEME.len())
        && prefix.eq_ignore_ascii_case(GITHUB_SCHEME)
    {
        rest = rest[GITHUB_SCHEME.len()..].trim();
    }
    if rest.is_empty() {
        return Err(bad(input, "empty"));
    }

    // Split off the ref first (delimited LAST by `@`, so it may contain `/`).
    let mut git_ref: Option<String> = None;
    if let Some(at) = rest.find('@') {
        let candidate = rest[at + 1..].trim();
        rest = &rest[..at];
        if candidate.is_empty() {
            return Err(bad(input, "empty ref after \"@\""));
        }
        validate_ref(candidate, input)?;
        git_ref = Some(candidate.to_string());
    }

    // The remainder is `owner/repo[/subdir]`.
    let parts: Vec<&str> = rest.split('/').collect();
    if parts.len() < 2 {
        return Err(bad(input, "expected owner/repo[/subdir][@ref]"));
    }
    let owner = parts[0];
    let raw_repo = parts[1];
    let sub_parts = &parts[2..];

    if !OWNER_RE.is_match(owner) {
        return Err(bad(input, &format!("bad owner \"{owner}\"")));
    }
    // Tolerate a pasted `owner/repo.git` (a single trailing `.git` —
    // `raw_repo` holds no `/`, so this is one path segment).
    let repo = raw_repo.strip_suffix(".git").unwrap_or(raw_repo);
    // The repo charset allows dots, but a dots-only repo (`.` / `..` — reachable
    // as `owner/...git` after the strip) would put a real dot-segment into the
    // codeload URL path. Clients normalize it away before sending (so it only
    // 404s), but the URL and the recorded provenance MUST NOT carry one.
    if !REPO_RE.is_match(repo) || repo.bytes().all(|b| b == b'.') {
        return Err(bad(input, &format!("bad repo \"{raw_repo}\"")));
    }
    for seg in sub_parts {
        if seg.is_empty() || *seg == "." || *seg == ".." {
            return Err(bad(input, &format!("bad subdir segment \"{seg}\"")));
        }
    }
    let subdir = if sub_parts.is_empty() {
        None
    } else {
        Some(sub_parts.join("/"))
    };

    Ok(GithubSpec {
        owner: owner.to_string(),
        repo: repo.to_string(),
        subdir,
        git_ref,
    })
}

/// The codeload tarball URL for a spec (ref defaults to `HEAD` = the default
/// branch — codeload accepts the literal `HEAD`).
pub fn github_tarball_url(spec: &GithubSpec) -> String {
    let git_ref = spec.git_ref.as_deref().unwrap_or("HEAD");
    // codeload takes the ref as a URL path, so a slashed ref keeps its slashes
    // while each segment is percent-encoded (verified: `.../tar.gz/releases/v1`).
    let ref_path = git_ref
        .split('/')
        .map(percent_encode_component)
        .collect::<Vec<_>>()
        .join("/");
    format!(
        "https://codeload.github.com/{}/{}/tar.gz/{}",
        percent_encode_component(&spec.owner),
        percent_encode_component(&spec.repo),
        ref_path,
    )
}

/// The `meta.source` provenance string for a spec — round-trips through
/// [`parse_github_spec`].
pub fn github_source(spec: &GithubSpec) -> String {
    format!("{GITHUB_SCHEME}{}", format_spec(spec))
}

/// Per-read timeout for the codeload download — bounds a stalled connection
/// without capping a large-but-progressing transfer (a total timeout would).
const DOWNLOAD_READ_TIMEOUT: Duration = Duration::from_secs(60);

/// Fetch a recipe from GitHub and create an instance. Downloads the codeload
/// tarball with one blocking rustls client and streams the response body straight
/// into [`ingest_bundle`] (never buffered whole in RAM); `spec.subdir` narrows
/// ingestion to a path inside the repo. Public repos only.
///
/// This is BLOCKING (the whole extract pipeline is sync); async callers wrap it in
/// `spawn_blocking`. It is the download half deferred from Phase 1d, landing here
/// with `ingest_bundle` so the fetch → gunzip → untar → locate pipeline is one unit.
pub fn ingest_github(
    input: &str,
    instances_dir: &str,
    opts: GithubIngestOpts,
) -> Result<Instance, Error> {
    let spec = parse_github_spec(input)?;
    let url = github_tarball_url(&spec);
    let described = format_spec(&spec);

    // One Agent = one pooled client (rustls/ring, redirect-follow by default).
    let agent = ureq::AgentBuilder::new()
        .user_agent(concat!("compositz/", env!("CARGO_PKG_VERSION")))
        .timeout_read(DOWNLOAD_READ_TIMEOUT)
        .build();

    let response = match agent.get(&url).call() {
        Ok(response) => response,
        // ureq treats a non-2xx as an error. A 404 is by far the most common
        // failure (typo'd repo / ref, or a private repo we can't see) — name it.
        Err(ureq::Error::Status(code, _)) => {
            let hint = if code == 404 {
                " (repo or ref not found; private repos are not supported)"
            } else {
                ""
            };
            return Err(Error::Github(format!(
                "GitHub download failed for {described}: {code}{hint}"
            )));
        }
        Err(ureq::Error::Transport(transport)) => {
            return Err(Error::Github(format!(
                "failed to reach GitHub for {described}: {transport}"
            )));
        }
    };

    // `into_reader` streams the body (per-read timeout applies), so an arbitrarily
    // large tarball is never buffered whole — it flows straight into extraction.
    let reader: Box<dyn std::io::Read + Send> = Box::new(response.into_reader());
    ingest_bundle(
        BundleSource::Archive {
            reader,
            subdir: spec.subdir.clone(),
        },
        instances_dir,
        IngestOpts {
            source: Some(github_source(&spec)),
            created_at: opts.created_at,
        },
    )
}

/// Options for a GitHub ingest (mirrors the Deno `opts`; `source` is fixed to the
/// spec's provenance string, so only `created_at` is caller-overridable).
#[derive(Debug, Default, Clone)]
pub struct GithubIngestOpts {
    pub created_at: Option<String>,
}

/// Human-readable `owner/repo[/subdir][@ref]` (no scheme) for messages + provenance.
fn format_spec(spec: &GithubSpec) -> String {
    let sub = spec
        .subdir
        .as_deref()
        .map(|s| format!("/{s}"))
        .unwrap_or_default();
    let git_ref = spec
        .git_ref
        .as_deref()
        .map(|r| format!("@{r}"))
        .unwrap_or_default();
    format!("{}/{}{sub}{git_ref}", spec.owner, spec.repo)
}

/// A git ref may contain `/` but never whitespace, control chars, or a `.`/`..`
/// (or empty) path segment. Mirrors the Deno `validateRef`; the segment rules keep
/// a slashed ref from smuggling `..` into the codeload URL path.
fn validate_ref(git_ref: &str, input: &str) -> Result<(), Error> {
    // Reject control chars / whitespace by scalar value (≤ 0x20 covers space + all
    // C0 controls; 0x7f is DEL), and any empty / `.` / `..` path segment.
    let has_bad_char = git_ref
        .chars()
        .any(|ch| (ch as u32) <= 0x20 || (ch as u32) == 0x7f);
    let has_bad_seg = git_ref
        .split('/')
        .any(|seg| seg.is_empty() || seg == "." || seg == "..");
    if has_bad_char || has_bad_seg {
        return Err(bad(input, &format!("bad ref \"{git_ref}\"")));
    }
    Ok(())
}

/// Percent-encode one URL path component exactly as JS `encodeURIComponent` does:
/// every byte except the unreserved set `A-Za-z0-9` and `- _ . ! ~ * ' ( )` is
/// escaped as `%XX` (uppercase hex, UTF-8 bytes). Matching the Deno source keeps
/// the codeload URL byte-identical; a `/`-free component stays intact (slashes are
/// the segment delimiter, re-joined by the caller).
fn percent_encode_component(component: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(component.len());
    for &byte in component.as_bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push(HEX[(byte >> 4) as usize] as char);
            out.push(HEX[(byte & 0x0f) as usize] as char);
        }
    }
    out
}

/// Build a uniform `invalid GitHub spec "<input>": <detail>` error (mirrors the
/// Deno `CompositzError` message shape so callers/UI see identical text).
fn bad(input: &str, detail: &str) -> Error {
    Error::Github(format!("invalid GitHub spec \"{input}\": {detail}"))
}
