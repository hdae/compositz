import { assertEquals, assertStringIncludes } from "@std/assert";
import { type Instance, type Manifest } from "@compositz/core";
import { toInstanceView } from "./instance-view.ts";

function instance(manifest: Manifest, overrides: Partial<Instance> = {}): Instance {
  return {
    instanceId: "hello-a1b2c3d4",
    appId: manifest.id,
    dir: "/store/hello-a1b2c3d4", // no config.yaml there → empty override
    manifest,
    context: [],
    meta: { source: "github:owner/repo", createdAt: "2026-01-01T00:00:00Z" },
    ...overrides,
  };
}

const baseManifest = {
  manifestVersion: 2,
  id: "hello",
  name: "Hello",
  version: "0.1.0",
  description: "A hello app.",
  build: { dockerfile: "Dockerfile" },
  ports: [],
  mounts: [],
  cache: [],
  env: [],
  gpu: "none",
} satisfies Manifest;

Deno.test("toInstanceView: maps identity, name, version, description", async () => {
  const view = await toInstanceView(instance(baseManifest));
  assertEquals(view.instanceId, "hello-a1b2c3d4");
  assertEquals(view.appId, "hello");
  assertEquals(view.name, "Hello");
  assertEquals(view.version, "0.1.0");
  assertEquals(view.description, "A hello app.");
});

Deno.test("toInstanceView: a missing description becomes an empty string", async () => {
  const { description: _drop, ...noDesc } = baseManifest;
  const view = await toInstanceView(instance(noDesc satisfies Manifest));
  assertEquals(view.description, "");
});

Deno.test("toInstanceView: webPorts includes ONLY web:true ports, with the view fields", async () => {
  const manifest = {
    ...baseManifest,
    ports: [
      {
        name: "ui",
        container: 8188,
        host: 8188,
        protocol: "tcp",
        web: true,
        path: "/",
        description: "Web UI.",
      },
      { name: "api", container: 9000, protocol: "tcp", web: false, path: "/" },
      { name: "alt", container: 8189, protocol: "tcp", web: true, path: "/admin" },
    ],
  } satisfies Manifest;
  const view = await toInstanceView(instance(manifest));
  assertEquals(view.webPorts, [
    // host = override ▷ manifest host ▷ container: ui declares host 8188; alt has none → container 8189
    { name: "ui", container: 8188, protocol: "tcp", path: "/", host: 8188, description: "Web UI." },
    {
      name: "alt",
      container: 8189,
      protocol: "tcp",
      path: "/admin",
      host: 8189,
      description: undefined,
    },
  ]);
});

Deno.test("toInstanceView: imageTag for a build recipe carries the instanceId + version", async () => {
  const view = await toInstanceView(instance(baseManifest));
  assertStringIncludes(view.imageTag, "hello-a1b2c3d4");
  assertStringIncludes(view.imageTag, "0.1.0");
});

Deno.test("toInstanceView: an image-based recipe uses the external image as the tag", async () => {
  const { build: _drop, ...rest } = baseManifest;
  const manifest = { ...rest, image: "ollama/ollama:0.6.0" } satisfies Manifest;
  const view = await toInstanceView(instance(manifest));
  assertEquals(view.imageTag, "ollama/ollama:0.6.0");
});
