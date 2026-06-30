import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import {
  githubSource,
  type GithubSpec,
  githubTarballUrl,
  ingestGithub,
  parseGithubSpec,
} from "./github.ts";
import { CompositzError } from "../errors.ts";

// --- parseGithubSpec: the grammar `owner/repo[/subdir][@ref]` ---------------

Deno.test("parseGithubSpec: bare owner/repo (default branch)", () => {
  assertEquals(parseGithubSpec("octocat/Hello-World"), {
    owner: "octocat",
    repo: "Hello-World",
    subdir: undefined,
    ref: undefined,
  });
});

Deno.test("parseGithubSpec: an optional github: scheme prefix is stripped", () => {
  assertEquals(
    parseGithubSpec("github:octocat/Hello-World"),
    parseGithubSpec("octocat/Hello-World"),
  );
  // case-insensitive scheme, surrounding whitespace tolerated
  assertEquals(
    parseGithubSpec("  GitHub:octocat/Hello-World  "),
    parseGithubSpec("octocat/Hello-World"),
  );
});

Deno.test("parseGithubSpec: @ref (branch / tag / sha)", () => {
  assertEquals(parseGithubSpec("owner/repo@v1.2.3").ref, "v1.2.3");
  assertEquals(parseGithubSpec("owner/repo@main").ref, "main");
  assertEquals(parseGithubSpec("owner/repo@0a1b2c3d").ref, "0a1b2c3d");
});

Deno.test("parseGithubSpec: a SLASHED ref is kept whole (the point of subdir-before-ref)", () => {
  // `releases/v1` is a real long-lived branch shape; it must NOT be split into a subdir.
  assertEquals(parseGithubSpec("actions/checkout@releases/v1"), {
    owner: "actions",
    repo: "checkout",
    subdir: undefined,
    ref: "releases/v1",
  });
});

Deno.test("parseGithubSpec: subdir between repo and @ref", () => {
  assertEquals(parseGithubSpec("owner/repo/apps/web@v1"), {
    owner: "owner",
    repo: "repo",
    subdir: "apps/web",
    ref: "v1",
  });
});

Deno.test("parseGithubSpec: a slashed ref AND a subdir coexist unambiguously", () => {
  assertEquals(parseGithubSpec("owner/repo/packages/api@feature/login"), {
    owner: "owner",
    repo: "repo",
    subdir: "packages/api",
    ref: "feature/login",
  });
});

Deno.test("parseGithubSpec: subdir without a ref", () => {
  assertEquals(parseGithubSpec("owner/repo/recipes/comfyui"), {
    owner: "owner",
    repo: "repo",
    subdir: "recipes/comfyui",
    ref: undefined,
  });
});

Deno.test("parseGithubSpec: a trailing .git on the repo is tolerated", () => {
  assertEquals(parseGithubSpec("owner/repo.git@main").repo, "repo");
});

Deno.test("parseGithubSpec: rejects malformed specs", () => {
  const bad = [
    "", // empty
    "github:", // scheme only
    "owner", // no repo
    "owner/", // empty repo segment (trailing slash)
    "owner//repo", // empty owner-side segment
    "-owner/repo", // owner can't start with a hyphen
    "ow ner/repo", // space in owner
    "owner/re po", // space in repo
    "owner/repo@", // empty ref
    "owner/repo@ bad ref", // whitespace in ref
    "owner/repo/../etc@main", // `..` subdir segment
    "owner/repo@../escape", // `..` ref segment
    "owner/repo/sub/", // trailing slash → empty subdir segment
  ];
  for (const spec of bad) {
    assertThrows(
      () => parseGithubSpec(spec),
      CompositzError,
      "",
      `expected reject: ${JSON.stringify(spec)}`,
    );
  }
});

// --- githubTarballUrl -------------------------------------------------------

Deno.test("githubTarballUrl: ref defaults to HEAD (the default branch)", () => {
  assertEquals(
    githubTarballUrl({ owner: "octocat", repo: "Hello-World" }),
    "https://codeload.github.com/octocat/Hello-World/tar.gz/HEAD",
  );
});

Deno.test("githubTarballUrl: an explicit ref is used verbatim", () => {
  assertEquals(
    githubTarballUrl({ owner: "owner", repo: "repo", ref: "v1.2.3" }),
    "https://codeload.github.com/owner/repo/tar.gz/v1.2.3",
  );
});

Deno.test("githubTarballUrl: a slashed ref keeps its slashes, each segment encoded", () => {
  assertEquals(
    githubTarballUrl({ owner: "actions", repo: "checkout", ref: "releases/v1" }),
    "https://codeload.github.com/actions/checkout/tar.gz/releases/v1",
  );
});

Deno.test("githubTarballUrl: the subdir does NOT affect the download URL (whole repo)", () => {
  assertEquals(
    githubTarballUrl({ owner: "owner", repo: "repo", subdir: "apps/web", ref: "main" }),
    "https://codeload.github.com/owner/repo/tar.gz/main",
  );
});

// --- githubSource: provenance round-trips through the parser -----------------

Deno.test("githubSource: round-trips through parseGithubSpec", () => {
  const specs: GithubSpec[] = [
    { owner: "octocat", repo: "Hello-World" },
    { owner: "owner", repo: "repo", ref: "v1" },
    { owner: "owner", repo: "repo", subdir: "apps/web" },
    { owner: "owner", repo: "repo", subdir: "packages/api", ref: "feature/login" },
  ];
  for (const spec of specs) {
    const source = githubSource(spec);
    assertStringIncludes(source, "github:");
    assertEquals(parseGithubSpec(source), { subdir: undefined, ref: undefined, ...spec });
  }
});

// --- integration: real codeload (opt-in via COMPOSITZ_NET_TESTS=1) ----------
//
// Proves the fetch → gunzip → untar → locate pipeline reaches GitHub end-to-end.
// octocat/Hello-World has no compositz.yaml, so a successful download must fail at
// manifest validation — confirming the network glue without needing a recipe repo.

const NET = Deno.env.get("COMPOSITZ_NET_TESTS") === "1";

Deno.test({
  name: "ingestGithub: downloads & extracts a real repo, rejecting it for no manifest",
  ignore: !NET,
  async fn() {
    const store = await Deno.makeTempDir({ prefix: "compositz-gh-" });
    try {
      await assertRejects(
        () => ingestGithub("octocat/Hello-World", store),
        CompositzError,
        "no compositz.yaml",
      );
    } finally {
      await Deno.remove(store, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "ingestGithub: a missing repo/ref surfaces a clear 404 error",
  ignore: !NET,
  async fn() {
    const store = await Deno.makeTempDir({ prefix: "compositz-gh-" });
    try {
      await assertRejects(
        () => ingestGithub("octocat/no-such-repo-xyz-123", store),
        CompositzError,
        "404",
      );
    } finally {
      await Deno.remove(store, { recursive: true }).catch(() => {});
    }
  },
});
