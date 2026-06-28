import { assertEquals, assertThrows } from "@std/assert";
import { parseDockerHost } from "./transport.ts";
import { splitImageRef } from "./engine/client.ts";

Deno.test("parseDockerHost: unix", () => {
  assertEquals(parseDockerHost("unix:///var/run/docker.sock"), {
    kind: "unix",
    path: "/var/run/docker.sock",
  });
});

Deno.test("parseDockerHost: npipe normalizes forward slashes to backslashes", () => {
  assertEquals(parseDockerHost("npipe:////./pipe/docker_engine"), {
    kind: "npipe",
    path: "\\\\.\\pipe\\docker_engine",
  });
});

Deno.test("parseDockerHost: tcp", () => {
  assertEquals(parseDockerHost("tcp://127.0.0.1:2375"), {
    kind: "tcp",
    host: "127.0.0.1",
    port: 2375,
  });
});

Deno.test("parseDockerHost: rejects unknown scheme", () => {
  assertThrows(() => parseDockerHost("ssh://host"));
});

Deno.test("splitImageRef: bare name defaults to latest", () => {
  assertEquals(splitImageRef("alpine"), { name: "alpine", tag: "latest" });
});

Deno.test("splitImageRef: explicit tag", () => {
  assertEquals(splitImageRef("alpine:3.20"), { name: "alpine", tag: "3.20" });
});

Deno.test("splitImageRef: registry with port keeps the host colon", () => {
  assertEquals(splitImageRef("localhost:5000/team/app:v1"), {
    name: "localhost:5000/team/app",
    tag: "v1",
  });
});

Deno.test("splitImageRef: digest-pinned ref", () => {
  assertEquals(splitImageRef("alpine@sha256:deadbeef"), {
    name: "alpine@sha256:deadbeef",
    tag: "",
  });
});
