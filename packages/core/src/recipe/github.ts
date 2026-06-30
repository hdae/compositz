// Ingest a recipe straight from GitHub (ADR-014, RI-3): download the codeload
// tarball over HTTPS and hand it to `ingestBundle` — no `git` binary, public repos
// only (private-repo auth is deferred). The ref is OPTIONAL; omitted ⇒ the repo's
// default branch (codeload accepts the literal `HEAD`). A subdir narrows ingestion to
// a path inside the repo (a monorepo that hosts several recipes).
//
// SPEC GRAMMAR (DECIDED: ADR-021 — amends ADR-014's `owner/repo[@ref][/subdir]`):
//
//     owner/repo[/subdir][@ref]
//
// The ref is delimited LAST by `@`, so it MAY itself contain `/` (e.g. `@releases/v1`
// — verified against codeload); the subdir sits between repo and `@ref`. Putting the
// subdir BEFORE the ref is what makes the grammar unambiguous: a slashed branch name
// and a subdir can coexist without the parser having to guess where one ends. An
// optional `github:` scheme prefix is accepted (it mirrors `meta.source`).

import { CompositzError } from "../errors.ts";
import { ingestBundle } from "./ingest.ts";
import type { Instance } from "./instance.ts";

const GITHUB_SCHEME = "github:";
// GitHub login: alphanumeric + hyphen, no leading hyphen, ≤39 chars.
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
// GitHub repo name: alphanumeric plus `.`, `_`, `-`.
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** A parsed GitHub source: `owner/repo[/subdir][@ref]`. */
export type GithubSpec = {
  owner: string;
  repo: string;
  /** Path inside the repo to the recipe directory (a monorepo subdir). */
  subdir?: string;
  /** Git ref — branch / tag / commit SHA. Omitted ⇒ the repo's default branch. */
  ref?: string;
};

/**
 * Parse `owner/repo[/subdir][@ref]` (with an optional `github:` prefix) into a
 * {@link GithubSpec}. Throws {@link CompositzError} on a malformed spec. Pure — no I/O.
 */
export function parseGithubSpec(input: string): GithubSpec {
  let rest = input.trim();
  if (rest.toLowerCase().startsWith(GITHUB_SCHEME)) rest = rest.slice(GITHUB_SCHEME.length).trim();
  if (rest === "") throw new CompositzError(`invalid GitHub spec "${input}": empty`);

  // Split off the ref first (delimited last by `@`, so it may contain `/`).
  let ref: string | undefined;
  const at = rest.indexOf("@");
  if (at !== -1) {
    ref = rest.slice(at + 1).trim();
    rest = rest.slice(0, at);
    if (ref === "") throw new CompositzError(`invalid GitHub spec "${input}": empty ref after "@"`);
    validateRef(ref, input);
  }

  // The remainder is `owner/repo[/subdir]`.
  const parts = rest.split("/");
  if (parts.length < 2) {
    throw new CompositzError(`invalid GitHub spec "${input}": expected owner/repo[/subdir][@ref]`);
  }
  const [owner, rawRepo, ...subParts] = parts;
  if (!OWNER_RE.test(owner)) {
    throw new CompositzError(`invalid GitHub spec "${input}": bad owner "${owner}"`);
  }
  const repo = rawRepo.replace(/\.git$/, ""); // tolerate a pasted `owner/repo.git`
  if (!REPO_RE.test(repo)) {
    throw new CompositzError(`invalid GitHub spec "${input}": bad repo "${rawRepo}"`);
  }
  for (const seg of subParts) {
    if (seg === "" || seg === "." || seg === "..") {
      throw new CompositzError(`invalid GitHub spec "${input}": bad subdir segment "${seg}"`);
    }
  }
  const subdir = subParts.length ? subParts.join("/") : undefined;
  return { owner, repo, subdir, ref };
}

/** The codeload tarball URL for a spec (ref defaults to `HEAD` = the default branch). */
export function githubTarballUrl(spec: GithubSpec): string {
  const ref = spec.ref ?? "HEAD";
  // codeload takes the ref as a URL path, so a slashed ref keeps its slashes while
  // each segment is percent-encoded (verified: `.../tar.gz/releases/v1`).
  const refPath = ref.split("/").map(encodeURIComponent).join("/");
  const owner = encodeURIComponent(spec.owner);
  const repo = encodeURIComponent(spec.repo);
  return `https://codeload.github.com/${owner}/${repo}/tar.gz/${refPath}`;
}

/** The `meta.source` provenance string for a spec — round-trips through {@link parseGithubSpec}. */
export function githubSource(spec: GithubSpec): string {
  return `${GITHUB_SCHEME}${formatSpec(spec)}`;
}

/**
 * Fetch a recipe from GitHub and create an instance. Streams the codeload tarball
 * straight into {@link ingestBundle} (never buffered whole in RAM); `spec.subdir`
 * narrows ingestion to a path inside the repo. Public repos only.
 */
export async function ingestGithub(
  input: string | GithubSpec,
  instancesDir: string,
  opts: { signal?: AbortSignal; createdAt?: string } = {},
): Promise<Instance> {
  const spec = typeof input === "string" ? parseGithubSpec(input) : input;
  const url = githubTarballUrl(spec);

  let res: Response;
  try {
    res = await fetch(url, { signal: opts.signal, redirect: "follow" });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new CompositzError(
      `failed to reach GitHub for ${formatSpec(spec)}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  if (!res.ok) {
    await res.body?.cancel();
    const hint = res.status === 404
      ? " (repo or ref not found; private repos are not supported)"
      : "";
    throw new CompositzError(
      `GitHub download failed for ${formatSpec(spec)}: ${res.status} ${res.statusText}${hint}`,
    );
  }
  if (!res.body) {
    throw new CompositzError(`GitHub returned an empty body for ${formatSpec(spec)}`);
  }

  return await ingestBundle(
    { kind: "archive", stream: res.body, subdir: spec.subdir },
    instancesDir,
    { source: githubSource(spec), createdAt: opts.createdAt },
  );
}

/** Human-readable `owner/repo[/subdir][@ref]` (no scheme) for messages + provenance. */
function formatSpec(spec: GithubSpec): string {
  const sub = spec.subdir ? `/${spec.subdir}` : "";
  const ref = spec.ref ? `@${spec.ref}` : "";
  return `${spec.owner}/${spec.repo}${sub}${ref}`;
}

/** A git ref may contain `/` but never whitespace, control chars, or a `.`/`..` segment. */
function validateRef(ref: string, input: string): void {
  // Reject control chars / whitespace via char code (a literal \x00-\x1f regex trips
  // the no-control-regex lint), and any empty / `.` / `..` path segment.
  const hasBadChar = [...ref].some((ch) => ch.charCodeAt(0) <= 0x20 || ch.charCodeAt(0) === 0x7f);
  const hasBadSeg = ref.split("/").some((seg) => seg === "" || seg === "." || seg === "..");
  if (hasBadChar || hasBadSeg) {
    throw new CompositzError(`invalid GitHub spec "${input}": bad ref "${ref}"`);
  }
}
