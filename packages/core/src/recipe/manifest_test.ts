import { assertEquals, assertThrows } from "@std/assert";
import { type Manifest, parseManifest, RECIPE_ID_PATTERN } from "./manifest.ts";

Deno.test("RECIPE_ID_PATTERN: accepts valid ids, rejects path-shaped / uppercase / blank", () => {
  for (const ok of ["comfyui", "hello-web", "a", "x0-9"]) {
    assertEquals(RECIPE_ID_PATTERN.test(ok), true, ok);
  }
  for (const bad of ["", "..", "../x", "a/b", "Abc", "_x", "x.y", "-x"]) {
    assertEquals(RECIPE_ID_PATTERN.test(bad), false, bad);
  }
});

const FULL = `
manifestVersion: 2
id: comfyui
name: ComfyUI
version: "0.1.0"
description: Node-based Stable Diffusion UI.
build:
  dockerfile: Dockerfile
  args:
    CUDA: "12.4"
ports:
  - name: ui
    container: 8188
    host: 8188
    web: true
    description: Web UI.
  - name: api
    container: 9000
    protocol: udp
mounts:
  - name: output
    target: /app/output
    placement: bind
  - name: models
    target: /app/models
cache:
  - type: venv
  - type: huggingface
  - type: custom
    name: torch
    env: TORCH_HOME
    scope: instance
env:
  - name: HF_TOKEN
    description: HuggingFace token.
    required: false
    default: ""
gpu: required
`;

Deno.test("parseManifest: full v2 manifest round-trips", () => {
  const m = parseManifest(FULL);
  assertEquals(m.id, "comfyui");
  assertEquals(m.build?.args?.CUDA, "12.4");
  assertEquals(m.ports[0], {
    name: "ui",
    container: 8188,
    host: 8188,
    protocol: "tcp",
    web: true,
    path: "/",
    description: "Web UI.",
  });
  // protocol/web/path defaults applied to the second port.
  assertEquals(m.ports[1], {
    name: "api",
    container: 9000,
    protocol: "udp",
    web: false,
    path: "/",
  });
  assertEquals(m.mounts[0], { name: "output", target: "/app/output", placement: "bind" });
  assertEquals(m.mounts[1], { name: "models", target: "/app/models", placement: "volume" });
  assertEquals(m.cache, [
    { type: "venv" },
    { type: "huggingface" },
    { type: "custom", name: "torch", env: "TORCH_HOME", scope: "instance" },
  ]);
  assertEquals(m.env[0], {
    name: "HF_TOKEN",
    description: "HuggingFace token.",
    required: false,
    default: "",
  });
  assertEquals(m.gpu, "required");
});

Deno.test("parseManifest: applies defaults to a minimal build recipe", () => {
  const m: Manifest = parseManifest(`
manifestVersion: 2
id: minimal
name: Minimal
version: "1.0"
build: {}
`);
  assertEquals(m.build?.dockerfile, "Dockerfile");
  assertEquals(m.gpu, "preferred");
  assertEquals(m.ports, []);
  assertEquals(m.mounts, []);
  assertEquals(m.cache, []);
  assertEquals(m.env, []);
  assertEquals(m.image, undefined);
});

Deno.test("parseManifest: accepts an image-based recipe (no build)", () => {
  const m = parseManifest(`
manifestVersion: 2
id: ollama
name: Ollama
version: "0.6.0"
image: ollama/ollama:0.6.0
gpu: preferred
`);
  assertEquals(m.image, "ollama/ollama:0.6.0");
  assertEquals(m.build, undefined);
});

Deno.test("parseManifest: rejects a recipe with neither build nor image", () => {
  assertThrows(
    () => parseManifest("manifestVersion: 2\nid: x\nname: X\nversion: '1'"),
    Error,
    "build` or `image",
  );
});

Deno.test("parseManifest: rejects build and image together", () => {
  assertThrows(
    () =>
      parseManifest(
        "manifestVersion: 2\nid: x\nname: X\nversion: '1'\nbuild: {}\nimage: nginx:alpine",
      ),
    Error,
    "mutually exclusive",
  );
});

Deno.test("parseManifest: rejects wrong manifestVersion", () => {
  assertThrows(
    () => parseManifest("manifestVersion: 1\nid: x\nname: X\nversion: '1'\nbuild: {}"),
    Error,
    "manifestVersion",
  );
});

Deno.test("parseManifest: rejects bad id", () => {
  assertThrows(
    () => parseManifest("manifestVersion: 2\nid: Bad_ID\nname: X\nversion: '1'\nbuild: {}"),
    Error,
    "id",
  );
});

Deno.test("parseManifest: rejects bad gpu mode", () => {
  assertThrows(
    () => parseManifest("manifestVersion: 2\nid: x\nname: X\nversion: '1'\nbuild: {}\ngpu: maybe"),
    Error,
    "gpu",
  );
});

Deno.test("parseManifest: rejects unknown keys (strict)", () => {
  assertThrows(
    () => parseManifest("manifestVersion: 2\nid: x\nname: X\nversion: '1'\nbuild: {}\ntypo: true"),
    Error,
  );
});

Deno.test("parseManifest: rejects out-of-range port", () => {
  assertThrows(
    () =>
      parseManifest(
        "manifestVersion: 2\nid: x\nname: X\nversion: '1'\nbuild: {}\nports:\n  - name: ui\n    container: 70000",
      ),
    Error,
    "ports[0].container",
  );
});

Deno.test("parseManifest: rejects duplicate port names", () => {
  assertThrows(
    () =>
      parseManifest(`
manifestVersion: 2
id: x
name: X
version: "1"
build: {}
ports:
  - name: ui
    container: 80
  - name: ui
    container: 81
`),
    Error,
    'duplicate ports entry "ui"',
  );
});

Deno.test("parseManifest: rejects duplicate mount names", () => {
  assertThrows(
    () =>
      parseManifest(`
manifestVersion: 2
id: x
name: X
version: "1"
build: {}
mounts:
  - name: data
    target: /a
  - name: data
    target: /b
`),
    Error,
    'duplicate mounts entry "data"',
  );
});

Deno.test("parseManifest: rejects a duplicated cache preset", () => {
  assertThrows(
    () =>
      parseManifest(`
manifestVersion: 2
id: x
name: X
version: "1"
build: {}
cache:
  - type: venv
  - type: venv
`),
    Error,
    'duplicate cache entry "venv"',
  );
});

Deno.test("parseManifest: allows two custom caches with distinct names", () => {
  const m = parseManifest(`
manifestVersion: 2
id: x
name: X
version: "1"
build: {}
cache:
  - type: custom
    name: a
    env: A_HOME
  - type: custom
    name: b
    env: B_HOME
`);
  assertEquals(m.cache.length, 2);
});

Deno.test("parseManifest: rejects a mount name that would traverse the data-root", () => {
  assertThrows(
    () =>
      parseManifest(`
manifestVersion: 2
id: x
name: X
version: "1"
build: {}
mounts:
  - name: ../../etc
    target: /data
`),
    Error,
    "mounts[0].name",
  );
});

Deno.test("parseManifest: rejects a non-absolute mount target", () => {
  assertThrows(
    () =>
      parseManifest(
        "manifestVersion: 2\nid: x\nname: X\nversion: '1'\nbuild: {}\nmounts:\n  - name: data\n    target: rel/path",
      ),
    Error,
    "mounts[0].target",
  );
});

Deno.test("parseManifest: rejects an invalid env var name", () => {
  assertThrows(
    () =>
      parseManifest(
        "manifestVersion: 2\nid: x\nname: X\nversion: '1'\nbuild: {}\nenv:\n  - name: BAD-NAME",
      ),
    Error,
    "env[0].name",
  );
});

Deno.test("parseManifest: rejects a relative ports[].path (would build a malformed URL)", () => {
  assertThrows(
    () =>
      parseManifest(
        "manifestVersion: 2\nid: x\nname: X\nversion: '1'\nbuild: {}\nports:\n  - name: ui\n    container: 80\n    path: api/v1",
      ),
    Error,
    "ports[0].path",
  );
});

Deno.test("parseManifest: rejects a blank name", () => {
  assertThrows(
    () => parseManifest('manifestVersion: 2\nid: x\nname: "   "\nversion: "1"\nbuild: {}'),
    Error,
    "name",
  );
});

Deno.test("parseManifest: rejects a version outside the image-tag charset", () => {
  assertThrows(
    () => parseManifest('manifestVersion: 2\nid: x\nname: X\nversion: "1 0/bad"\nbuild: {}'),
    Error,
    "version",
  );
});

Deno.test("parseManifest: rejects an image reference with unsafe characters", () => {
  assertThrows(
    () => parseManifest('manifestVersion: 2\nid: x\nname: X\nversion: "1"\nimage: "bad image?x"'),
    Error,
    "image",
  );
});

Deno.test("parseManifest: rejects two mounts on the same target", () => {
  assertThrows(
    () =>
      parseManifest(`
manifestVersion: 2
id: x
name: X
version: "1"
build: {}
mounts:
  - name: a
    target: /data
  - name: b
    target: /data
`),
    Error,
    "duplicate mount target",
  );
});

Deno.test("parseManifest: custom cache requires name and env", () => {
  assertThrows(
    () =>
      parseManifest(
        "manifestVersion: 2\nid: x\nname: X\nversion: '1'\nbuild: {}\ncache:\n  - type: custom",
      ),
    Error,
  );
});
