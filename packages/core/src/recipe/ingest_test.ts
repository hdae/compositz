import { assertEquals, assertMatch, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  type BundleSource,
  duplicateInstance,
  extractArchiveTo,
  ingestBundle,
  INSTANCE_ID_PATTERN,
  randomInstanceId,
} from "./ingest.ts";
import { loadInstance, loadInstanceConfig } from "./instance.ts";

const MANIFEST = `manifestVersion: 2
id: hello
name: Hello
version: "0.1.0"
build: { dockerfile: Dockerfile }
gpu: none
`;
const DOCKERFILE = "FROM scratch\n";
const enc = new TextEncoder();

// --- a hand-rolled ustar tar builder, so we can craft MALICIOUS entries that
// @std/tar's TarStream would refuse to write (absolute / `..` / symlink). ---------

type TarEntry = { path: string; data?: Uint8Array; typeflag?: string; linkname?: string };

function tarHeader(path: string, size: number, typeflag: string, linkname: string): Uint8Array {
  const h = new Uint8Array(512);
  const put = (s: string, off: number, len: number) => h.set(enc.encode(s).subarray(0, len), off);
  put(path, 0, 100);
  put("0000644\0", 100, 8); // mode
  put("0000000\0", 108, 8); // uid
  put("0000000\0", 116, 8); // gid
  put(size.toString(8).padStart(11, "0") + "\0", 124, 12);
  put("00000000000\0", 136, 12); // mtime
  for (let i = 148; i < 156; i++) h[i] = 0x20; // checksum field = spaces while summing
  put(typeflag, 156, 1);
  put(linkname, 157, 100);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}

function makeTar(entries: TarEntry[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const e of entries) {
    const data = e.data ?? new Uint8Array(0);
    blocks.push(tarHeader(e.path, data.length, e.typeflag ?? "0", e.linkname ?? ""));
    if (data.length) {
      const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
      padded.set(data);
      blocks.push(padded);
    }
  }
  blocks.push(new Uint8Array(1024)); // two trailing zero blocks
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of blocks) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const gz = ReadableStream.from([bytes]).pipeThrough(
    new CompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>,
  );
  return await new Response(gz).bytes();
}

/** Wrap bytes as a byte stream (extraction now takes a ReadableStream). */
const S = (bytes: Uint8Array): ReadableStream<Uint8Array> => ReadableStream.from([bytes]);
const archive = (bytes: Uint8Array): BundleSource => ({ kind: "archive", stream: S(bytes) });

async function withStore<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "compositz-store-" });
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

const VALID_TAR = () =>
  makeTar([
    { path: "compositz.yaml", data: enc.encode(MANIFEST) },
    { path: "Dockerfile", data: enc.encode(DOCKERFILE) },
  ]);

// --- happy paths -----------------------------------------------------------

Deno.test("ingestBundle: a flat tar creates an instance under a minted id", async () => {
  await withStore(async (store) => {
    const inst = await ingestBundle(archive(VALID_TAR()), store);
    assertMatch(inst.instanceId, /^hello-[0-9a-z]{8}$/);
    assertEquals(inst.appId, "hello");
    assertEquals(inst.manifest.name, "Hello");
    assertEquals(inst.meta.source, "upload");
    // The bundle is materialized at <instanceId>/app/, re-loadable.
    const reloaded = await loadInstance(join(store, inst.instanceId));
    assertEquals(reloaded.manifest.id, "hello");
    assertEquals((await Deno.stat(join(store, inst.instanceId, "app", "Dockerfile"))).isFile, true);
  });
});

Deno.test("ingestBundle: a single top-level wrapper dir is unwrapped", async () => {
  await withStore(async (store) => {
    const tar = makeTar([
      { path: "hello-recipe/compositz.yaml", data: enc.encode(MANIFEST) },
      { path: "hello-recipe/Dockerfile", data: enc.encode(DOCKERFILE) },
    ]);
    const inst = await ingestBundle(archive(tar), store);
    assertEquals(inst.appId, "hello");
    assertEquals((await Deno.stat(join(store, inst.instanceId, "app", "Dockerfile"))).isFile, true);
  });
});

Deno.test("ingestBundle: gzip is auto-detected by magic bytes", async () => {
  await withStore(async (store) => {
    const inst = await ingestBundle(archive(await gzip(VALID_TAR())), store);
    assertEquals(inst.appId, "hello");
  });
});

Deno.test("ingestBundle: a local directory source is copied in", async () => {
  await withStore(async (store) => {
    const src = await Deno.makeTempDir({ prefix: "compositz-src-" });
    try {
      await Deno.writeTextFile(join(src, "compositz.yaml"), MANIFEST);
      await Deno.writeTextFile(join(src, "Dockerfile"), DOCKERFILE);
      const inst = await ingestBundle({ kind: "dir", dir: src }, store);
      assertEquals(inst.appId, "hello");
      assertStringIncludes(inst.meta.source ?? "", "dir:");
    } finally {
      await Deno.remove(src, { recursive: true }).catch(() => {});
    }
  });
});

Deno.test("duplicateInstance: copies only app/, mints a new id", async () => {
  await withStore(async (store) => {
    const a = await ingestBundle(archive(VALID_TAR()), store);
    const b = await duplicateInstance(store, a.instanceId);
    assertEquals(b.appId, "hello");
    assertEquals(b.instanceId === a.instanceId, false);
    assertEquals(b.meta.source, `duplicate:${a.instanceId}`);
    assertEquals((await Deno.stat(join(store, b.instanceId, "app", "Dockerfile"))).isFile, true);
  });
});

Deno.test("duplicateInstance: data / launch state / ports do NOT carry over", async () => {
  await withStore(async (store) => {
    const a = await ingestBundle(archive(VALID_TAR()), store);
    // simulate per-instance state next to app/: a ports-only override + launch
    // snapshot + a data marker
    await Deno.writeTextFile(join(store, a.instanceId, "config.yaml"), "hostPorts:\n  web: 9999\n");
    await Deno.writeTextFile(join(store, a.instanceId, ".launched.yaml"), "env: {}\n");
    await Deno.mkdir(join(store, a.instanceId, "data"));
    await Deno.writeTextFile(join(store, a.instanceId, "data", "output.txt"), "secret");

    const b = await duplicateInstance(store, a.instanceId);
    // the bundle is copied…
    assertEquals((await Deno.stat(join(store, b.instanceId, "app", "Dockerfile"))).isFile, true);
    // …but data / launch snapshot never carry over, and a hostPorts-only override
    // inherits as NOTHING (ports are per-copy; no config.yaml gets written at all)
    assertEquals(await exists(join(store, b.instanceId, "config.yaml")), false);
    assertEquals(await exists(join(store, b.instanceId, ".launched.yaml")), false);
    assertEquals(await exists(join(store, b.instanceId, "data")), false);
  });
});

Deno.test("duplicateInstance: inherits the Settings override (env, placement) minus hostPorts", async () => {
  await withStore(async (store) => {
    const a = await ingestBundle(archive(VALID_TAR()), store);
    await Deno.writeTextFile(
      join(store, a.instanceId, "config.yaml"),
      "hostPorts:\n  web: 9999\nenv:\n  TOKEN: sekrit\nplacement:\n  models: bind\n",
    );
    const b = await duplicateInstance(store, a.instanceId);
    const cfg = await loadInstanceConfig(join(store, b.instanceId));
    assertEquals(cfg.env, { TOKEN: "sekrit" });
    assertEquals(cfg.placement, { models: "bind" });
    assertEquals(cfg.hostPorts, undefined);
  });
});

// --- subdir descent (GitHub monorepo, RI-3) --------------------------------

Deno.test("ingestBundle: a subdir descends into a path inside a codeload-style wrapper", async () => {
  await withStore(async (store) => {
    const tar = makeTar([
      { path: "repo-main/README.md", data: enc.encode("top-level noise") },
      { path: "repo-main/recipes/hello/compositz.yaml", data: enc.encode(MANIFEST) },
      { path: "repo-main/recipes/hello/Dockerfile", data: enc.encode(DOCKERFILE) },
    ]);
    const inst = await ingestBundle(
      { kind: "archive", stream: S(tar), subdir: "recipes/hello" },
      store,
    );
    assertEquals(inst.appId, "hello");
    assertEquals((await Deno.stat(join(store, inst.instanceId, "app", "Dockerfile"))).isFile, true);
  });
});

Deno.test("ingestBundle: a subdir works without a top-level wrapper dir too", async () => {
  await withStore(async (store) => {
    const tar = makeTar([
      { path: "recipes/hello/compositz.yaml", data: enc.encode(MANIFEST) },
      { path: "recipes/hello/Dockerfile", data: enc.encode(DOCKERFILE) },
    ]);
    const inst = await ingestBundle(
      { kind: "archive", stream: S(tar), subdir: "recipes/hello" },
      store,
    );
    assertEquals(inst.appId, "hello");
  });
});

Deno.test("ingestBundle: a subdir with no manifest is rejected, naming the subdir", async () => {
  await withStore(async (store) => {
    const tar = makeTar([
      { path: "repo-main/recipes/hello/compositz.yaml", data: enc.encode(MANIFEST) },
      { path: "repo-main/recipes/hello/Dockerfile", data: enc.encode(DOCKERFILE) },
    ]);
    await assertRejects(
      () => ingestBundle({ kind: "archive", stream: S(tar), subdir: "recipes/missing" }, store),
      Error,
      'under "recipes/missing"',
    );
  });
});

Deno.test("ingestBundle: a subdir that escapes the bundle is rejected", async () => {
  await withStore(async (store) => {
    const tar = makeTar([{ path: "repo-main/compositz.yaml", data: enc.encode(MANIFEST) }]);
    await assertRejects(
      () => ingestBundle({ kind: "archive", stream: S(tar), subdir: "../escape" }, store),
      Error,
      "must be a path inside the bundle",
    );
  });
});

// --- security: extraction refuses to escape the destination ----------------

Deno.test("extractArchiveTo: rejects a `..` traversal path", async () => {
  await withStore(async (dir) => {
    const tar = makeTar([{ path: "../escape.txt", data: enc.encode("pwned") }]);
    await assertRejects(() => extractArchiveTo(S(tar), dir), Error, "escapes the bundle");
    // nothing was written outside the destination
    assertEquals(await exists(join(dir, "..", "escape.txt")), false);
  });
});

Deno.test("extractArchiveTo: rejects an absolute path", async () => {
  await withStore(async (dir) => {
    const tar = makeTar([{ path: "/tmp/compositz-escape.txt", data: enc.encode("pwned") }]);
    await assertRejects(() => extractArchiveTo(S(tar), dir), Error, "escapes the bundle");
  });
});

Deno.test("extractArchiveTo: rejects a symlink entry", async () => {
  await withStore(async (dir) => {
    const tar = makeTar([{ path: "link", typeflag: "2", linkname: "/etc/passwd" }]);
    await assertRejects(() => extractArchiveTo(S(tar), dir), Error, "symlinks");
  });
});

Deno.test("extractArchiveTo: rejects a hardlink entry", async () => {
  await withStore(async (dir) => {
    const tar = makeTar([{ path: "hard", typeflag: "1", linkname: "secret" }]);
    await assertRejects(() => extractArchiveTo(S(tar), dir), Error, "hardlinks");
  });
});

Deno.test("extractArchiveTo: rejects a device-node entry (char/block/fifo)", async () => {
  await withStore(async (dir) => {
    const tar = makeTar([{ path: "dev", typeflag: "3" }]); // char device
    await assertRejects(() => extractArchiveTo(S(tar), dir), Error, "devices");
  });
});

Deno.test("extractArchiveTo: rejects a deeply-nested path that escapes after normalize", async () => {
  await withStore(async (dir) => {
    // normalizes to ../escape.txt
    const tar = makeTar([{ path: "subdir/../../escape.txt", data: enc.encode("pwned") }]);
    await assertRejects(() => extractArchiveTo(S(tar), dir), Error, "escapes the bundle");
  });
});

Deno.test("extractArchiveTo: rejects traversal inside a gzip archive too", async () => {
  await withStore(async (dir) => {
    const gz = await gzip(makeTar([{ path: "../escape.txt", data: enc.encode("pwned") }]));
    await assertRejects(() => extractArchiveTo(S(gz), dir), Error, "escapes the bundle");
  });
});

Deno.test("extractArchiveTo: a path that normalizes back inside the root is allowed", async () => {
  await withStore(async (dir) => {
    // a/../b.txt normalizes to b.txt — legitimate, must NOT be rejected
    await extractArchiveTo(S(makeTar([{ path: "a/../b.txt", data: enc.encode("ok") }])), dir);
    assertEquals(await Deno.readTextFile(join(dir, "b.txt")), "ok");
  });
});

Deno.test("extractArchiveTo: an empty-name entry is skipped, not fatal", async () => {
  await withStore(async (dir) => {
    const tar = makeTar([
      { path: "", data: enc.encode("x") },
      { path: "real.txt", data: enc.encode("ok") },
    ]);
    await extractArchiveTo(S(tar), dir);
    assertEquals(await Deno.readTextFile(join(dir, "real.txt")), "ok");
  });
});

// --- structural rejection --------------------------------------------------

Deno.test("ingestBundle: a bundle with no manifest is rejected", async () => {
  await withStore(async (store) => {
    const tar = makeTar([{ path: "README.md", data: enc.encode("hi") }]);
    await assertRejects(() => ingestBundle(archive(tar), store), Error, "no compositz.yaml");
  });
});

Deno.test("ingestBundle: a bundle with two top-level manifests is ambiguous", async () => {
  await withStore(async (store) => {
    const tar = makeTar([
      { path: "a/compositz.yaml", data: enc.encode(MANIFEST) },
      { path: "a/Dockerfile", data: enc.encode(DOCKERFILE) },
      { path: "b/compositz.yaml", data: enc.encode(MANIFEST) },
      { path: "b/Dockerfile", data: enc.encode(DOCKERFILE) },
    ]);
    await assertRejects(() => ingestBundle(archive(tar), store), Error, "ambiguous");
  });
});

Deno.test("ingestBundle: an invalid manifest is rejected by Zod", async () => {
  await withStore(async (store) => {
    const tar = makeTar([
      { path: "compositz.yaml", data: enc.encode("manifestVersion: 2\nid: BAD_CAPS\n") },
    ]);
    await assertRejects(() => ingestBundle(archive(tar), store), Error);
  });
});

// --- id minting ------------------------------------------------------------

Deno.test("randomInstanceId: <appId>-<rand>, matches INSTANCE_ID_PATTERN", () => {
  const id = randomInstanceId("comfyui");
  assertMatch(id, /^comfyui-[0-9a-z]{8}$/);
  assertMatch(id, INSTANCE_ID_PATTERN);
  // 50 draws are all well-formed and all distinct — a constant-returning bug
  // (e.g. mocked crypto) collapses the set to size 1 and fails deterministically.
  const draws = Array.from({ length: 50 }, () => randomInstanceId("x"));
  draws.forEach((d) => assertMatch(d, /^x-[0-9a-z]{8}$/));
  assertEquals(new Set(draws).size, 50);
});

Deno.test("INSTANCE_ID_PATTERN: accepts minted ids, rejects path-shaped / uppercase ids", () => {
  for (const ok of ["hello-web-a1b2c3", "x-00000000", "comfyui"]) {
    assertMatch(ok, INSTANCE_ID_PATTERN);
  }
  // these must be rejected before reaching join(store, id) in the UI route
  for (const bad of ["../other", "a/b", "UPPER", ".", "", "a\\b", "foo/../bar"]) {
    assertEquals(INSTANCE_ID_PATTERN.test(bad), false);
  }
});

async function exists(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
}
