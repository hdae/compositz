import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ingestBundle } from "./ingest.ts";
import { listInstances, loadInstance, removeInstanceDir } from "./instance.ts";

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
