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

use crate::Error;
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
    // Tolerate a pasted `owner/repo.git` (a single trailing `.git`, like the Deno
    // `/\.git$/` — `raw_repo` holds no `/`, so this is one path segment).
    let repo = raw_repo.strip_suffix(".git").unwrap_or(raw_repo);
    if !REPO_RE.is_match(repo) {
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
