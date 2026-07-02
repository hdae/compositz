import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { ingestBundle } from "./ingest.ts";
import {
  CONFIG_FILE,
  listInstances,
  loadInstance,
  loadInstanceConfig,
  loadLaunchedConfig,
  removeInstanceDir,
  saveInstanceConfig,
  saveLaunchedConfig,
} from "./instance.ts";
import { CompositzError } from "../errors.ts";

const MANIFEST = (id: string, name: string) =>
  `manifestVersion: 2
id: ${id}
name: ${name}
version: "0.1.0"
build: { dockerfile: Dockerfile }
gpu: none
`;

async function dirBundle(id: string, name: string): Promise<string> {
  const src = await Deno.makeTempDir({ prefix: "compositz-src-" });
  await Deno.writeTextFile(join(src, "compositz.yaml"), MANIFEST(id, name));
  await Deno.writeTextFile(join(src, "Dockerfile"), "FROM scratch\n");
  return src;
}

Deno.test("listInstances: lists valid instances sorted by name; skips junk and staging dirs", async () => {
  const store = await Deno.makeTempDir({ prefix: "compositz-store-" });
  try {
    const zSrc = await dirBundle("zed", "Zed");
    const aSrc = await dirBundle("apex", "Apex");
    const z = await ingestBundle({ kind: "dir", dir: zSrc }, store);
    const a = await ingestBundle({ kind: "dir", dir: aSrc }, store);

    // noise the loader must ignore
    await Deno.writeTextFile(join(store, "loose-file.txt"), "x");
    await Deno.mkdir(join(store, ".ingest-leftover"));
    await Deno.mkdir(join(store, "not-an-instance")); // no app/ bundle

    const list = await listInstances(store);
    assertEquals(list.map((i) => i.manifest.name), ["Apex", "Zed"]); // sorted by name
    assertEquals(list.map((i) => i.instanceId).sort(), [a.instanceId, z.instanceId].sort());

    await Deno.remove(zSrc, { recursive: true });
    await Deno.remove(aSrc, { recursive: true });
  } finally {
    await Deno.remove(store, { recursive: true }).catch(() => {});
  }
});

Deno.test("loadInstance: instanceId comes from the directory name; meta is read", async () => {
  const store = await Deno.makeTempDir({ prefix: "compositz-store-" });
  try {
    const src = await dirBundle("hello", "Hello");
    const created = await ingestBundle({ kind: "dir", dir: src }, store, { source: "test" });
    const loaded = await loadInstance(join(store, created.instanceId));
    assertEquals(loaded.instanceId, created.instanceId);
    assertEquals(loaded.appId, "hello");
    assertEquals(loaded.meta.source, "test");
    await Deno.remove(src, { recursive: true });
  } finally {
    await Deno.remove(store, { recursive: true }).catch(() => {});
  }
});

Deno.test("removeInstanceDir: deletes the instance definition (idempotent)", async () => {
  const store = await Deno.makeTempDir({ prefix: "compositz-store-" });
  try {
    const src = await dirBundle("hello", "Hello");
    const inst = await ingestBundle({ kind: "dir", dir: src }, store);
    await removeInstanceDir(store, inst.instanceId);
    assertEquals((await listInstances(store)).length, 0);
    await removeInstanceDir(store, inst.instanceId); // no-op, no throw
    await Deno.remove(src, { recursive: true });
  } finally {
    await Deno.remove(store, { recursive: true }).catch(() => {});
  }
});

Deno.test("removeInstanceDir: rejects a path-shaped id — the store must survive", async () => {
  const store = await Deno.makeTempDir({ prefix: "compositz-store-" });
  try {
    const src = await dirBundle("hello", "Hello");
    const inst = await ingestBundle({ kind: "dir", dir: src }, store);

    // `rm .` / `rm ..` / traversal must throw BEFORE any filesystem delete —
    // otherwise the recursive remove wipes the whole store (or app-data) and
    // mass-orphans every instance's volumes.
    for (const evil of [".", "..", "a/b", "../store", "UPPER", ""]) {
      await assertRejects(() => removeInstanceDir(store, evil), CompositzError, "invalid");
    }
    assertEquals((await listInstances(store)).length, 1); // untouched

    await removeInstanceDir(store, inst.instanceId); // the real one still works
    assertEquals((await listInstances(store)).length, 0);
    await Deno.remove(src, { recursive: true });
  } finally {
    await Deno.remove(store, { recursive: true }).catch(() => {});
  }
});

// --- per-instance launch override (config.yaml, RI-4) ----------------------

Deno.test("loadInstanceConfig: a fresh instance (no config.yaml) is the empty override", async () => {
  const store = await Deno.makeTempDir({ prefix: "compositz-store-" });
  try {
    const src = await dirBundle("hello", "Hello");
    const inst = await ingestBundle({ kind: "dir", dir: src }, store);
    assertEquals(await loadInstanceConfig(join(store, inst.instanceId)), {});
    await Deno.remove(src, { recursive: true });
  } finally {
    await Deno.remove(store, { recursive: true }).catch(() => {});
  }
});

Deno.test("saveInstanceConfig → loadInstanceConfig: round-trips the override", async () => {
  const store = await Deno.makeTempDir({ prefix: "compositz-store-" });
  try {
    const src = await dirBundle("hello", "Hello");
    const inst = await ingestBundle({ kind: "dir", dir: src }, store);
    const dir = join(store, inst.instanceId);
    const override = {
      hostPorts: { ui: 8189 },
      env: { TOKEN: "x" },
      placement: { out: "bind" as const },
    };
    await saveInstanceConfig(dir, override);
    assertEquals(await loadInstanceConfig(dir), override);
    await Deno.remove(src, { recursive: true });
  } finally {
    await Deno.remove(store, { recursive: true }).catch(() => {});
  }
});

Deno.test("loadInstanceConfig: an invalid config.yaml throws (fail loud, never silently ignore)", async () => {
  const store = await Deno.makeTempDir({ prefix: "compositz-store-" });
  try {
    const src = await dirBundle("hello", "Hello");
    const inst = await ingestBundle({ kind: "dir", dir: src }, store);
    const dir = join(store, inst.instanceId);
    await Deno.writeTextFile(join(dir, CONFIG_FILE), "hostPorts: { ui: 70000 }\n"); // out of range
    await assertRejects(() => loadInstanceConfig(dir), CompositzError);
    await Deno.remove(src, { recursive: true });
  } finally {
    await Deno.remove(store, { recursive: true }).catch(() => {});
  }
});

Deno.test("loadLaunchedConfig: undefined until launched; round-trips; independent of config.yaml", async () => {
  const store = await Deno.makeTempDir({ prefix: "compositz-store-" });
  try {
    const src = await dirBundle("hello", "Hello");
    const inst = await ingestBundle({ kind: "dir", dir: src }, store);
    const dir = join(store, inst.instanceId);

    // never launched ⇒ undefined (distinct from the empty override `{}`)
    assertEquals(await loadLaunchedConfig(dir), undefined);

    // launch with a given override → recorded separately from config.yaml
    await saveLaunchedConfig(dir, { hostPorts: { web: 8090 } });
    assertEquals(await loadLaunchedConfig(dir), { hostPorts: { web: 8090 } });

    // editing config.yaml does NOT change the launched snapshot (so a divergence is detectable)
    await saveInstanceConfig(dir, { hostPorts: { web: 8099 } });
    assertEquals(await loadLaunchedConfig(dir), { hostPorts: { web: 8090 } });
    assertEquals(await loadInstanceConfig(dir), { hostPorts: { web: 8099 } });
    await Deno.remove(src, { recursive: true });
  } finally {
    await Deno.remove(store, { recursive: true }).catch(() => {});
  }
});
