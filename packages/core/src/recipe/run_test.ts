import { assertEquals } from "@std/assert";
import { parseManifest } from "./manifest.ts";
import { recipeContainerName, recipeImageTag, toCreateSpec, webUrl } from "./run.ts";

const m = parseManifest(`
manifestVersion: 1
id: comfyui
name: ComfyUI
version: "0.2.0"
web:
  port: 8188
  hostPort: 7860
ports:
  - container: 9000
    protocol: udp
env:
  - FOO=bar
volumes:
  - name: models
    target: /data
gpu: preferred
`);

Deno.test("recipe naming derives from brand + manifest", () => {
  assertEquals(recipeImageTag(m), "compositz/comfyui:0.2.0");
  assertEquals(recipeContainerName(m), "compositz-comfyui");
  assertEquals(webUrl(m), "http://localhost:7860/");
});

Deno.test("toCreateSpec maps ports, web, volumes, gpu", () => {
  const spec = toCreateSpec(m);
  assertEquals(spec.Image, "compositz/comfyui:0.2.0");
  assertEquals(spec.Env, ["FOO=bar"]);
  // web (8188/tcp -> 7860) and extra port (9000/udp -> 9000)
  assertEquals(spec.ExposedPorts, { "9000/udp": {}, "8188/tcp": {} });
  assertEquals(spec.HostConfig?.PortBindings?.["8188/tcp"], [{ HostPort: "7860" }]);
  assertEquals(spec.HostConfig?.PortBindings?.["9000/udp"], [{ HostPort: "9000" }]);
  assertEquals(spec.HostConfig?.Binds, ["compositz_comfyui_models:/data"]);
  // preferred -> GPU attached by default
  assertEquals(spec.HostConfig?.DeviceRequests?.[0].Capabilities, [["gpu"]]);
  assertEquals(spec.Labels?.["io.compositz.recipe"], "comfyui");
});

Deno.test("toCreateSpec withGpu:false omits DeviceRequests", () => {
  const spec = toCreateSpec(m, { withGpu: false });
  assertEquals(spec.HostConfig?.DeviceRequests, undefined);
});

Deno.test("gpu:none manifest attaches no GPU", () => {
  const none = parseManifest("manifestVersion: 1\nid: x\nname: X\nversion: '1'\ngpu: none");
  assertEquals(toCreateSpec(none).HostConfig?.DeviceRequests, undefined);
});
