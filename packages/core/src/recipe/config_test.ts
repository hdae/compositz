import { assertEquals, assertThrows } from "@std/assert";
import { parseOverride, serializeOverride } from "./config.ts";
import { CompositzError } from "../errors.ts";

// --- parseOverride ---------------------------------------------------------

Deno.test("parseOverride: a full override parses to values keyed by name", () => {
  const yaml = `hostPorts:
  ui: 8189
env:
  HF_TOKEN: secret
placement:
  output: bind
`;
  assertEquals(parseOverride(yaml), {
    hostPorts: { ui: 8189 },
    env: { HF_TOKEN: "secret" },
    placement: { output: "bind" },
  });
});

Deno.test("parseOverride: an empty / blank file is a valid empty override", () => {
  assertEquals(parseOverride(""), {});
  assertEquals(parseOverride("\n"), {});
  assertEquals(parseOverride("{}\n"), {});
});

Deno.test("parseOverride: a partial override keeps only the present sections", () => {
  assertEquals(parseOverride("hostPorts: { ui: 9000 }\n"), { hostPorts: { ui: 9000 } });
});

Deno.test("parseOverride: rejects an out-of-range / non-integer host port", () => {
  assertThrows(() => parseOverride("hostPorts: { ui: 70000 }\n"), CompositzError);
  assertThrows(() => parseOverride("hostPorts: { ui: 0 }\n"), CompositzError);
  assertThrows(() => parseOverride("hostPorts: { ui: 80.5 }\n"), CompositzError);
});

Deno.test("parseOverride: rejects an invalid placement value", () => {
  assertThrows(() => parseOverride("placement: { output: tmpfs }\n"), CompositzError);
});

Deno.test("parseOverride: rejects an unknown top-level key (strict — catches typos)", () => {
  assertThrows(() => parseOverride("hostPort: { ui: 8189 }\n"), CompositzError); // singular typo
  assertThrows(() => parseOverride("dataRoot: /tmp/x\n"), CompositzError); // deferred, not persisted
});

Deno.test("parseOverride: rejects non-YAML / a non-string env value", () => {
  assertThrows(() => parseOverride("env:\n  HF_TOKEN: [1, 2]\n"), CompositzError);
});

// --- serializeOverride -----------------------------------------------------

Deno.test("serializeOverride: round-trips through parseOverride", () => {
  const override = {
    hostPorts: { ui: 8189, api: 9001 },
    env: { HF_TOKEN: "x" },
    placement: { output: "bind" as const },
  };
  assertEquals(parseOverride(serializeOverride(override)), override);
});

Deno.test("serializeOverride: drops empty sections for a clean file", () => {
  assertEquals(parseOverride(serializeOverride({ hostPorts: {}, env: {}, placement: {} })), {});
  assertEquals(serializeOverride({}), serializeOverride({ hostPorts: {} }));
});
