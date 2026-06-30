import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ingestBundle } from "./ingest.ts";
import { loadInstanceConfig } from "./instance.ts";
import { deconflictHostPorts } from "./operations.ts";

// `deconflictHostPorts` is engine-free (it reads only manifests ⊕ config.yaml of the
// OTHER instances), so it is hermetically testable. `up`/`down`/`install` need a live
// engine and are integration-verified elsewhere.

const MANIFEST = (id: string, host: number) =>
  `manifestVersion: 2
id: ${id}
name: ${id}
version: "0.1.0"
build: { dockerfile: Dockerfile }
ports:
  - { name: web, container: 80, host: ${host} }
gpu: none
`;

async function recipeDir(id: string, host: number): Promise<string> {
  const src = await Deno.makeTempDir({ prefix: "compositz-src-" });
  await Deno.writeTextFile(join(src, "compositz.yaml"), MANIFEST(id, host));
  await Deno.writeTextFile(join(src, "Dockerfile"), "FROM scratch\n");
  return src;
}

async function withStore(fn: (store: string) => Promise<void>): Promise<void> {
  const store = await Deno.makeTempDir({ prefix: "compositz-store-" });
  try {
    await fn(store);
  } finally {
    await Deno.remove(store, { recursive: true }).catch(() => {});
  }
}

Deno.test("deconflictHostPorts: the first instance has no conflict", async () => {
  await withStore(async (store) => {
    const src = await recipeDir("web", 8090);
    const a = await ingestBundle({ kind: "dir", dir: src }, store);
    assertEquals(await deconflictHostPorts(store, a), []);
    assertEquals(await loadInstanceConfig(a.dir), {}); // nothing written
    await Deno.remove(src, { recursive: true });
  });
});

Deno.test("deconflictHostPorts: a colliding port is bumped, persisted, and reported", async () => {
  await withStore(async (store) => {
    const src = await recipeDir("web", 8090);
    const a = await ingestBundle({ kind: "dir", dir: src }, store);
    await deconflictHostPorts(store, a);
    const b = await ingestBundle({ kind: "dir", dir: src }, store); // same recipe → wants 8090 too

    assertEquals(await deconflictHostPorts(store, b), [{ name: "web", from: 8090, to: 8091 }]);
    assertEquals((await loadInstanceConfig(b.dir)).hostPorts, { web: 8091 }); // persisted to B
    assertEquals(await loadInstanceConfig(a.dir), {}); // A untouched
    await Deno.remove(src, { recursive: true });
  });
});

Deno.test("deconflictHostPorts: the taken set honors OTHER instances' overrides, not just manifests", async () => {
  await withStore(async (store) => {
    const src = await recipeDir("web", 8090);
    const a = await ingestBundle({ kind: "dir", dir: src }, store);
    await deconflictHostPorts(store, a); // A = 8090
    const b = await ingestBundle({ kind: "dir", dir: src }, store);
    await deconflictHostPorts(store, b); // B bumped to 8091 (override)
    const c = await ingestBundle({ kind: "dir", dir: src }, store);

    // C must avoid A's manifest 8090 AND B's OVERRIDE 8091 → 8092.
    assertEquals(await deconflictHostPorts(store, c), [{ name: "web", from: 8090, to: 8092 }]);
    await Deno.remove(src, { recursive: true });
  });
});

Deno.test("deconflictHostPorts: distinct ports do not conflict; re-running is idempotent", async () => {
  await withStore(async (store) => {
    const srcA = await recipeDir("web", 8090);
    const srcB = await recipeDir("web", 9000);
    await ingestBundle({ kind: "dir", dir: srcA }, store); // occupies 8090
    const b = await ingestBundle({ kind: "dir", dir: srcB }, store);
    assertEquals(await deconflictHostPorts(store, b), []); // 9000 ≠ 8090
    assertEquals(await deconflictHostPorts(store, b), []); // again — still no bump
    assertEquals(await loadInstanceConfig(b.dir), {});
    await Deno.remove(srcA, { recursive: true });
    await Deno.remove(srcB, { recursive: true });
  });
});
