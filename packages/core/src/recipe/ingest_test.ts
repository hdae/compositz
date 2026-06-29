import { assertEquals, assertMatch, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  duplicateInstance,
  extractArchiveTo,
  ingestBundle,
  INSTANCE_ID_PATTERN,
  randomInstanceId,
} from "./ingest.ts";
import { loadInstance } from "./instance.ts";

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
    const inst = await ingestBundle({ kind: "archive", bytes: VALID_TAR() }, store);
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
    const inst = await ingestBundle({ kind: "archive", bytes: tar }, store);
    assertEquals(inst.appId, "hello");
    assertEquals((await Deno.stat(join(store, inst.instanceId, "app", "Dockerfile"))).isFile, true);
  });
});

Deno.test("ingestBundle: gzip is auto-detected by magic bytes", async () => {
  await withStore(async (store) => {
    const inst = await ingestBundle({ kind: "archive", bytes: await gzip(VALID_TAR()) }, store);
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
    const a = await ingestBundle({ kind: "archive", bytes: VALID_TAR() }, store);
    const b = await duplicateInstance(store, a.instanceId);
    assertEquals(b.appId, "hello");
    assertEquals(b.instanceId === a.instanceId, false);
    assertEquals(b.meta.source, `duplicate:${a.instanceId}`);
    assertEquals((await Deno.stat(join(store, b.instanceId, "app", "Dockerfile"))).isFile, true);
  });
});

// --- security: extraction refuses to escape the destination ----------------

Deno.test("extractArchiveTo: rejects a `..` traversal path", async () => {
  await withStore(async (dir) => {
    const tar = makeTar([{ path: "../escape.txt", data: enc.encode("pwned") }]);
    await assertRejects(() => extractArchiveTo(tar, dir), Error, "escapes the bundle");
    // nothing was written outside the destination
    assertEquals(await exists(join(dir, "..", "escape.txt")), false);
  });
});

Deno.test("extractArchiveTo: rejects an absolute path", async () => {
  await withStore(async (dir) => {
    const tar = makeTar([{ path: "/tmp/compositz-escape.txt", data: enc.encode("pwned") }]);
    await assertRejects(() => extractArchiveTo(tar, dir), Error, "escapes the bundle");
  });
});

Deno.test("extractArchiveTo: rejects a symlink entry", async () => {
  await withStore(async (dir) => {
    const tar = makeTar([{ path: "link", typeflag: "2", linkname: "/etc/passwd" }]);
    await assertRejects(() => extractArchiveTo(tar, dir), Error, "symlinks");
  });
});

Deno.test("extractArchiveTo: rejects a hardlink entry", async () => {
  await withStore(async (dir) => {
    const tar = makeTar([{ path: "hard", typeflag: "1", linkname: "secret" }]);
    await assertRejects(() => extractArchiveTo(tar, dir), Error, "hardlinks");
  });
});

// --- structural rejection --------------------------------------------------

Deno.test("ingestBundle: a bundle with no manifest is rejected", async () => {
  await withStore(async (store) => {
    const tar = makeTar([{ path: "README.md", data: enc.encode("hi") }]);
    await assertRejects(
      () => ingestBundle({ kind: "archive", bytes: tar }, store),
      Error,
      "no compositz.yaml",
    );
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
    await assertRejects(
      () => ingestBundle({ kind: "archive", bytes: tar }, store),
      Error,
      "ambiguous",
    );
  });
});

Deno.test("ingestBundle: an invalid manifest is rejected by Zod", async () => {
  await withStore(async (store) => {
    const tar = makeTar([
      { path: "compositz.yaml", data: enc.encode("manifestVersion: 2\nid: BAD_CAPS\n") },
    ]);
    await assertRejects(() => ingestBundle({ kind: "archive", bytes: tar }, store), Error);
  });
});

// --- id minting ------------------------------------------------------------

Deno.test("randomInstanceId: <appId>-<rand>, matches INSTANCE_ID_PATTERN", () => {
  const id = randomInstanceId("comfyui");
  assertMatch(id, /^comfyui-[0-9a-z]{8}$/);
  assertMatch(id, INSTANCE_ID_PATTERN);
  // two draws differ (collision space 36^8)
  assertEquals(randomInstanceId("x") === randomInstanceId("x"), false);
});

async function exists(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
}
