import { assertEquals, assertThrows } from "@std/assert";
import { type Manifest, parseManifest } from "./manifest.ts";

const FULL = `
manifestVersion: 1
id: comfyui
name: ComfyUI
version: "0.1.0"
description: Node-based Stable Diffusion UI.
build:
  dockerfile: Dockerfile
  args:
    CUDA: "12.4"
web:
  port: 8188
  hostPort: 8188
ports:
  - container: 9000
    host: 9001
    protocol: tcp
env:
  - HF_HOME=/cache/hf
volumes:
  - name: models
    target: /root/.cache/huggingface
gpu: required
`;

Deno.test("parseManifest: full manifest round-trips", () => {
  const m = parseManifest(FULL);
  assertEquals(m.id, "comfyui");
  assertEquals(m.build.args?.CUDA, "12.4");
  assertEquals(m.web?.port, 8188);
  assertEquals(m.ports[0], { container: 9000, host: 9001, protocol: "tcp" });
  assertEquals(m.env, ["HF_HOME=/cache/hf"]);
  assertEquals(m.volumes[0], { name: "models", target: "/root/.cache/huggingface" });
  assertEquals(m.gpu, "required");
});

Deno.test("parseManifest: applies defaults", () => {
  const m: Manifest = parseManifest(`
manifestVersion: 1
id: minimal
name: Minimal
version: "1.0"
`);
  assertEquals(m.build.dockerfile, "Dockerfile");
  assertEquals(m.gpu, "preferred"); // default
  assertEquals(m.ports, []);
  assertEquals(m.env, []);
  assertEquals(m.volumes, []);
  assertEquals(m.web, undefined);
});

Deno.test("parseManifest: rejects wrong manifestVersion", () => {
  assertThrows(
    () => parseManifest("manifestVersion: 2\nid: x\nname: X\nversion: '1'"),
    Error,
    "manifestVersion",
  );
});

Deno.test("parseManifest: rejects bad id", () => {
  assertThrows(
    () => parseManifest("manifestVersion: 1\nid: Bad_ID\nname: X\nversion: '1'"),
    Error,
    "id",
  );
});

Deno.test("parseManifest: rejects bad gpu mode", () => {
  assertThrows(
    () => parseManifest("manifestVersion: 1\nid: x\nname: X\nversion: '1'\ngpu: maybe"),
    Error,
    "gpu",
  );
});

Deno.test("parseManifest: rejects env without '='", () => {
  assertThrows(
    () => parseManifest("manifestVersion: 1\nid: x\nname: X\nversion: '1'\nenv:\n  - NOPE"),
    Error,
    "env[0]",
  );
});

Deno.test("parseManifest: rejects unknown keys (strict)", () => {
  assertThrows(
    () => parseManifest("manifestVersion: 1\nid: x\nname: X\nversion: '1'\ntypo: true"),
    Error,
  );
});

Deno.test("parseManifest: rejects out-of-range port", () => {
  assertThrows(
    () => parseManifest("manifestVersion: 1\nid: x\nname: X\nversion: '1'\nweb:\n  port: 70000"),
    Error,
    "web.port",
  );
});
