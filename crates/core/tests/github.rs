//! Behavior tests for the GitHub source grammar, ported from the PURE half of
//! `packages/core/src/recipe/github_test.ts` (the `parseGithubSpec` /
//! `githubTarballUrl` / `githubSource` cases). The two network integration tests
//! call `ingestGithub`, which streams into `ingestBundle` (Phase 1e); they arrive
//! there with the download glue, since neither passes without the untar pipeline.

use compositz_core::recipe::github::{GithubIngestOpts, ingest_github};
use compositz_core::recipe::github::{
    GithubSpec, github_source, github_tarball_url, parse_github_spec,
};
use tempfile::TempDir;

/// Terser construction for the expected specs.
fn spec(owner: &str, repo: &str, subdir: Option<&str>, git_ref: Option<&str>) -> GithubSpec {
    GithubSpec {
        owner: owner.to_string(),
        repo: repo.to_string(),
        subdir: subdir.map(str::to_string),
        git_ref: git_ref.map(str::to_string),
    }
}

// --- parseGithubSpec: the grammar `owner/repo[/subdir][@ref]` ---------------

#[test]
fn parse_bare_owner_repo_defaults_the_branch() {
    assert_eq!(
        parse_github_spec("octocat/Hello-World").unwrap(),
        spec("octocat", "Hello-World", None, None)
    );
}

#[test]
fn parse_strips_an_optional_github_scheme_prefix() {
    let bare = parse_github_spec("octocat/Hello-World").unwrap();
    assert_eq!(
        parse_github_spec("github:octocat/Hello-World").unwrap(),
        bare
    );
    // Case-insensitive scheme, surrounding whitespace tolerated.
    assert_eq!(
        parse_github_spec("  GitHub:octocat/Hello-World  ").unwrap(),
        bare
    );
}

#[test]
fn parse_at_ref_branch_tag_or_sha() {
    assert_eq!(
        parse_github_spec("owner/repo@v1.2.3").unwrap().git_ref,
        Some("v1.2.3".to_string())
    );
    assert_eq!(
        parse_github_spec("owner/repo@main").unwrap().git_ref,
        Some("main".to_string())
    );
    assert_eq!(
        parse_github_spec("owner/repo@0a1b2c3d").unwrap().git_ref,
        Some("0a1b2c3d".to_string())
    );
}

#[test]
fn parse_keeps_a_slashed_ref_whole() {
    // `releases/v1` is a real long-lived branch shape; it must NOT split into a
    // subdir — the whole point of parsing the subdir BEFORE the `@ref`.
    assert_eq!(
        parse_github_spec("actions/checkout@releases/v1").unwrap(),
        spec("actions", "checkout", None, Some("releases/v1"))
    );
}

#[test]
fn parse_subdir_between_repo_and_ref() {
    assert_eq!(
        parse_github_spec("owner/repo/apps/web@v1").unwrap(),
        spec("owner", "repo", Some("apps/web"), Some("v1"))
    );
}

#[test]
fn parse_a_slashed_ref_and_a_subdir_coexist_unambiguously() {
    assert_eq!(
        parse_github_spec("owner/repo/packages/api@feature/login").unwrap(),
        spec("owner", "repo", Some("packages/api"), Some("feature/login"))
    );
}

#[test]
fn parse_subdir_without_a_ref() {
    assert_eq!(
        parse_github_spec("owner/repo/recipes/comfyui").unwrap(),
        spec("owner", "repo", Some("recipes/comfyui"), None)
    );
}

#[test]
fn parse_tolerates_a_trailing_dot_git_on_the_repo() {
    assert_eq!(
        parse_github_spec("owner/repo.git@main").unwrap().repo,
        "repo"
    );
}

#[test]
fn parse_rejects_malformed_specs() {
    let bad = [
        "",                       // empty
        "github:",                // scheme only
        "owner",                  // no repo
        "owner/",                 // empty repo segment (trailing slash)
        "owner//repo",            // empty owner-side segment
        "-owner/repo",            // owner can't start with a hyphen
        "ow ner/repo",            // space in owner
        "owner/re po",            // space in repo
        "owner/repo@",            // empty ref
        "owner/repo@ bad ref",    // whitespace in ref
        "owner/repo/../etc@main", // `..` subdir segment
        "owner/repo@../escape",   // `..` ref segment
        "owner/repo/sub/",        // trailing slash → empty subdir segment
    ];
    for input in bad {
        assert!(
            parse_github_spec(input).is_err(),
            "expected reject: {input:?}"
        );
    }
}

#[test]
fn parse_rejects_a_dots_only_repo_even_via_the_dot_git_strip() {
    // A `.`/`..` repo passes the charset but would emit a literal dot-segment
    // into the codeload URL path (`/owner/../tar.gz/HEAD`) and the provenance.
    let bad = [
        "owner/.",
        "owner/..",
        "owner/...",
        "owner/...git", // `.git` strip turns this into `..`
        "owner/..git",  // … and this into `.`
    ];
    for input in bad {
        assert!(
            parse_github_spec(input).is_err(),
            "expected reject: {input:?}"
        );
    }
    // Dots inside a real name stay fine (incl. a name that merely ends in dots).
    assert_eq!(parse_github_spec("owner/re.po").unwrap().repo, "re.po");
    assert_eq!(parse_github_spec("owner/repo..").unwrap().repo, "repo..");
}

// --- githubTarballUrl -------------------------------------------------------

#[test]
fn url_ref_defaults_to_head() {
    assert_eq!(
        github_tarball_url(&spec("octocat", "Hello-World", None, None)),
        "https://codeload.github.com/octocat/Hello-World/tar.gz/HEAD"
    );
}

#[test]
fn url_uses_an_explicit_ref_verbatim() {
    assert_eq!(
        github_tarball_url(&spec("owner", "repo", None, Some("v1.2.3"))),
        "https://codeload.github.com/owner/repo/tar.gz/v1.2.3"
    );
}

#[test]
fn url_keeps_a_slashed_ref_each_segment_encoded() {
    assert_eq!(
        github_tarball_url(&spec("actions", "checkout", None, Some("releases/v1"))),
        "https://codeload.github.com/actions/checkout/tar.gz/releases/v1"
    );
}

#[test]
fn url_subdir_does_not_affect_the_download_url() {
    assert_eq!(
        github_tarball_url(&spec("owner", "repo", Some("apps/web"), Some("main"))),
        "https://codeload.github.com/owner/repo/tar.gz/main"
    );
}

// --- githubSource: provenance round-trips through the parser -----------------

#[test]
fn source_round_trips_through_parse() {
    let specs = [
        spec("octocat", "Hello-World", None, None),
        spec("owner", "repo", None, Some("v1")),
        spec("owner", "repo", Some("apps/web"), None),
        spec("owner", "repo", Some("packages/api"), Some("feature/login")),
    ];
    for want in specs {
        let source = github_source(&want);
        assert!(
            source.contains("github:"),
            "source lost its scheme: {source}"
        );
        assert_eq!(parse_github_spec(&source).unwrap(), want);
    }
}

// --- security regressions (not in the Deno suite; guard the Rust port) -------

// A JS `$` (no `m` flag) never matches before a trailing newline; Rust's regex
// `$` must behave the same, or a control char at a segment's END would slip past
// OWNER_RE / REPO_RE. `owner/repo\n@main` puts `\n` as the LAST char of the repo
// segment (where a lax `\Z`-style anchor would wrongly match) — the port rejects
// it. Guards against a future `(?m)` / `\Z` regression, and confirms the parser's
// injection-safety does not rest on the charset alone.
#[test]
fn parse_rejects_an_embedded_newline_in_the_repo_segment() {
    assert!(parse_github_spec("owner/repo\n@main").is_err());
    assert!(parse_github_spec("own\ner/repo").is_err());
}

// `encodeURIComponent` escapes reserved bytes (e.g. `+` → `%2B`) but keeps the
// unreserved `~`; a naive pass-through would corrupt the codeload URL. `validateRef`
// permits both chars (neither is control/whitespace), so this reaches the encoder.
#[test]
fn url_percent_encodes_reserved_ref_bytes_and_keeps_unreserved() {
    let parsed = parse_github_spec("owner/repo@a+b~c").unwrap();
    assert_eq!(
        github_tarball_url(&parsed),
        "https://codeload.github.com/owner/repo/tar.gz/a%2Bb~c"
    );
}

// --- integration: real codeload (opt-in) ------------------------------------
//
// Proves the fetch → gunzip → untar → locate pipeline reaches GitHub end-to-end.
// `#[ignore]` keeps them out of a plain `cargo test`; the env guard means even
// `cargo test -- --ignored` is a no-op unless the network run is opted into:
//   COMPOSITZ_NET_TESTS=1 cargo test -p compositz-core --test github -- --ignored

fn net_enabled() -> bool {
    std::env::var("COMPOSITZ_NET_TESTS").as_deref() == Ok("1")
}

#[test]
#[ignore = "network; run with COMPOSITZ_NET_TESTS=1 and --ignored"]
fn ingest_github_downloads_a_real_repo_and_rejects_it_for_no_manifest() {
    if !net_enabled() {
        return;
    }
    // octocat/Hello-World has no compositz.yaml, so a successful download must fail
    // at bundle location — confirming the network glue without needing a recipe repo.
    let store = TempDir::new().unwrap();
    let err = ingest_github(
        "octocat/Hello-World",
        store.path().to_str().unwrap(),
        GithubIngestOpts::default(),
    )
    .unwrap_err();
    assert!(err.to_string().contains("no compositz.yaml"), "got: {err}");
}

#[test]
#[ignore = "network; run with COMPOSITZ_NET_TESTS=1 and --ignored"]
fn ingest_github_surfaces_a_clear_404_for_a_missing_repo() {
    if !net_enabled() {
        return;
    }
    let store = TempDir::new().unwrap();
    let err = ingest_github(
        "octocat/no-such-repo-xyz-123",
        store.path().to_str().unwrap(),
        GithubIngestOpts::default(),
    )
    .unwrap_err();
    assert!(err.to_string().contains("404"), "got: {err}");
}
