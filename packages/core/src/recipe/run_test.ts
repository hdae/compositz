import { assertEquals, assertThrows } from "@std/assert";
import { parseManifest } from "./manifest.ts";
import {
  recipeContainerName,
  recipeImageTag,
  resolveHostPorts,
  toCreateSpec,
  webEndpoints,
  webUrl,
} from "./run.ts";

const m = parseManifest(`
manifestVersion: 2
id: comfyui
name: ComfyUI
version: "0.2.0"
build: {}
ports:
  - name: ui
    container: 8188
    host: 7860
    web: true
  - name: api
    container: 9000
    protocol: udp
mounts:
  - name: output
    target: /out
    placement: bind
  - name: models
    target: /data
cache:
  - type: venv
  - type: huggingface
env:
  - name: FOO
    default: bar
gpu: preferred
`);

Deno.test("recipe naming derives from brand + manifest", () => {
  assertEquals(recipeImageTag(m), "compositz/comfyui:0.2.0");
  assertEquals(recipeContainerName(m), "compositz-comfyui");
});

Deno.test("image-based recipe runs the referenced image, not a built tag", () => {
  const img = parseManifest(
    'manifestVersion: 2\nid: ollama\nname: Ollama\nversion: "0.6.0"\nimage: ollama/ollama:0.6.0',
  );
  assertEquals(recipeImageTag(img), "ollama/ollama:0.6.0");
});

Deno.test("webEndpoints lists each web port; webUrl is the first", () => {
  const multi = parseManifest(`
manifestVersion: 2
id: x
name: X
version: "1"
build: {}
ports:
  - name: ui
    container: 80
    host: 8080
    web: true
  - name: admin
    container: 9000
    host: 9090
    web: true
    path: /admin
`);
  assertEquals(webEndpoints(multi), [
    { name: "ui", url: "http://localhost:8080/" },
    { name: "admin", url: "http://localhost:9090/admin" },
  ]);
  assertEquals(webUrl(multi), "http://localhost:8080/");
});

Deno.test("webUrl honors a launch host-port remap", () => {
  assertEquals(webUrl(m, { hostPorts: { ui: 7000 } }), "http://localhost:7000/");
});

Deno.test("toCreateSpec maps ports, mounts, caches, env, gpu", () => {
  const spec = toCreateSpec(m, { dataRoot: "/root" });
  assertEquals(spec.Image, "compositz/comfyui:0.2.0");
  assertEquals(spec.ExposedPorts, { "8188/tcp": {}, "9000/udp": {} });
  assertEquals(spec.HostConfig?.PortBindings?.["8188/tcp"], [{ HostPort: "7860" }]);
  assertEquals(spec.HostConfig?.PortBindings?.["9000/udp"], [{ HostPort: "9000" }]);

  // bind => host path under data-root; volume => managed named volume; caches appended.
  assertEquals(spec.HostConfig?.Mounts, [
    {
      Type: "bind",
      Source: "/root/comfyui/output",
      Target: "/out",
      BindOptions: { CreateMountpoint: true },
    },
    { Type: "volume", Source: "compositz_comfyui_models", Target: "/data" },
    { Type: "volume", Source: "compositz_uv", Target: "/compositz/uv" },
    { Type: "volume", Source: "compositz_hf", Target: "/compositz/hf" },
  ]);

  // user env (from default), then managed cache vars, then the instance marker.
  assertEquals(spec.Env, [
    "FOO=bar",
    "UV_CACHE_DIR=/compositz/uv/cache",
    "VIRTUAL_ENV=/compositz/uv/venvs/comfyui/default",
    "HF_HOME=/compositz/hf",
    "COMPOSITZ_INSTANCE=default",
  ]);

  assertEquals(spec.HostConfig?.DeviceRequests?.[0].Capabilities, [["gpu"]]);
  assertEquals(spec.Labels?.["io.compositz.recipe"], "comfyui");
  assertEquals(spec.Labels?.["io.compositz.instance"], "default");
});

Deno.test("toCreateSpec: launch overrides env value and instance", () => {
  const spec = toCreateSpec(m, { dataRoot: "/root", instance: "alt", env: { FOO: "baz" } });
  assertEquals(spec.Env?.includes("FOO=baz"), true);
  assertEquals(spec.Env?.includes("VIRTUAL_ENV=/compositz/uv/venvs/comfyui/alt"), true);
  assertEquals(spec.Env?.includes("COMPOSITZ_INSTANCE=alt"), true);
  assertEquals(spec.Labels?.["io.compositz.instance"], "alt");
});

Deno.test("toCreateSpec: a placement override flips bind<->volume", () => {
  const spec = toCreateSpec(m, { placement: { output: "volume" } });
  assertEquals(
    spec.HostConfig?.Mounts?.find((x) => x.Target === "/out"),
    { Type: "volume", Source: "compositz_comfyui_output", Target: "/out" },
  );
});

Deno.test("toCreateSpec: a bind mount without a dataRoot throws", () => {
  assertThrows(() => toCreateSpec(m), Error, "bind mount but no dataRoot");
});

Deno.test("toCreateSpec withGpu:false omits DeviceRequests", () => {
  assertEquals(
    toCreateSpec(m, { dataRoot: "/root", withGpu: false }).HostConfig?.DeviceRequests,
    undefined,
  );
});

Deno.test("gpu:none manifest attaches no GPU", () => {
  const none = parseManifest(
    "manifestVersion: 2\nid: x\nname: X\nversion: '1'\nbuild: {}\ngpu: none",
  );
  assertEquals(toCreateSpec(none).HostConfig?.DeviceRequests, undefined);
});

Deno.test("toCreateSpec: a volume-only recipe needs no dataRoot", () => {
  const vol = parseManifest(`
manifestVersion: 2
id: x
name: X
version: "1"
build: {}
mounts:
  - name: data
    target: /data
`);
  assertEquals(toCreateSpec(vol).HostConfig?.Mounts, [
    { Type: "volume", Source: "compositz_x_data", Target: "/data" },
  ]);
});

Deno.test("toCreateSpec: two ports on one container port publish to both host ports", () => {
  const dual = parseManifest(`
manifestVersion: 2
id: x
name: X
version: "1"
build: {}
ports:
  - name: a
    container: 80
    host: 8080
  - name: b
    container: 80
    host: 8081
`);
  assertEquals(toCreateSpec(dual).HostConfig?.PortBindings?.["80/tcp"], [
    { HostPort: "8080" },
    { HostPort: "8081" },
  ]);
});

Deno.test("toCreateSpec: a managed cache var overrides a colliding user env var", () => {
  const clash = parseManifest(`
manifestVersion: 2
id: x
name: X
version: "1"
build: {}
cache:
  - type: huggingface
env:
  - name: HF_HOME
    default: /wrong
`);
  // The user's HF_HOME=/wrong must not survive — the cache owns that path.
  const env = toCreateSpec(clash).Env ?? [];
  assertEquals(env.filter((e) => e.startsWith("HF_HOME=")), ["HF_HOME=/compositz/hf"]);
});

Deno.test("resolveHostPorts bumps colliding ports to the next free one", () => {
  const ports = [{ name: "ui", host: 8080 }, { name: "api", host: 8081 }];
  assertEquals(resolveHostPorts(ports, new Set([8080, 8081])), { ui: 8082, api: 8083 });
});

Deno.test("resolveHostPorts leaves free ports untouched", () => {
  assertEquals(resolveHostPorts([{ name: "ui", host: 9000 }], new Set([8080])), { ui: 9000 });
});

Deno.test("resolveHostPorts throws when no free port remains below 65535", () => {
  const taken = new Set<number>();
  for (let p = 65534; p <= 65535; p++) taken.add(p);
  assertThrows(
    () => resolveHostPorts([{ name: "ui", host: 65534 }], taken),
    Error,
    "no free host port",
  );
});

Deno.test("toCreateSpec throws when a user mount target collides with a managed cache target", () => {
  // The mount targets /compositz/hf, which the huggingface cache also owns.
  const clash = parseManifest(`
manifestVersion: 2
id: x
name: X
version: "1"
build: {}
mounts:
  - name: data
    target: /compositz/hf
cache:
  - type: huggingface
`);
  assertThrows(() => toCreateSpec(clash), Error, "duplicate mount target");
});

Deno.test("resolveHostPorts avoids self-collision among the recipe's own ports", () => {
  // Two ports want the same host port; the second is bumped.
  const ports = [{ name: "a", host: 5000 }, { name: "b", host: 5000 }];
  assertEquals(resolveHostPorts(ports, new Set()), { a: 5000, b: 5001 });
});
