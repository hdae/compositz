import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  appDataDir,
  bindHostPath,
  defaultDataRoot,
  instancesDir,
  type Platform,
} from "./storage.ts";

// Build a fake host environment. The path helpers join with the RUNTIME separator,
// so expectations are built with the same `join` rather than hardcoded slashes.
const platform = (os: string, vars: Record<string, string>): Platform => ({
  os,
  env: (k) => vars[k],
});

Deno.test("bindHostPath nests <data-root>/<instanceId>/<name>", () => {
  assertEquals(
    bindHostPath("/srv/data", "comfyui-a1b2c3", "output"),
    join("/srv/data", "comfyui-a1b2c3", "output"),
  );
});

Deno.test("instancesDir defaults to <app-data>/instances", () => {
  const p = platform("linux", { HOME: "/home/u" });
  assertEquals(instancesDir(p), join("/home/u", ".local", "share", "compositz", "instances"));
});

Deno.test("instancesDir honors COMPOSITZ_INSTANCES_DIR", () => {
  const p = platform("linux", { HOME: "/home/u", COMPOSITZ_INSTANCES_DIR: "/custom/store" });
  assertEquals(instancesDir(p), "/custom/store");
});

Deno.test("appDataDir: Linux prefers XDG_DATA_HOME", () => {
  const p = platform("linux", { XDG_DATA_HOME: "/x", HOME: "/home/u" });
  assertEquals(appDataDir(p), join("/x", "compositz"));
});

Deno.test("appDataDir: Linux falls back to ~/.local/share", () => {
  const p = platform("linux", { HOME: "/home/u" });
  assertEquals(appDataDir(p), join("/home/u", ".local", "share", "compositz"));
});

Deno.test("appDataDir: Windows uses %APPDATA%", () => {
  const p = platform("windows", { APPDATA: "C:/Users/u/AppData/Roaming" });
  assertEquals(appDataDir(p), join("C:/Users/u/AppData/Roaming", "compositz"));
});

Deno.test("defaultDataRoot: Linux is ~/Compositz", () => {
  assertEquals(
    defaultDataRoot(platform("linux", { HOME: "/home/u" })),
    join("/home/u", "Compositz"),
  );
});

Deno.test("defaultDataRoot: Windows is %USERPROFILE%\\Compositz", () => {
  const p = platform("windows", { USERPROFILE: "C:/Users/u" });
  assertEquals(defaultDataRoot(p), join("C:/Users/u", "Compositz"));
});

Deno.test("home resolution throws when unset", () => {
  assertThrows(() => defaultDataRoot(platform("linux", {})), Error, "home directory");
});
