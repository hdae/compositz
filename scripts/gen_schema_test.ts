// Guard: the committed spec/compositz.schema.json must stay in sync with the Zod
// manifest schema. The JSON Schema is a GENERATED artifact (manifestJsonSchema +
// the wrapper below, written by gen_schema.ts) with no other guard, so without this
// test a manifest change could silently leave the published schema describing the
// old contract. Regenerate with `deno task schema` when this fails.

import { assertEquals } from "@std/assert";
import { manifestJsonSchema } from "@compositz/core";

Deno.test("spec/compositz.schema.json is in sync with the Zod manifest schema", async () => {
  // Mirror of scripts/gen_schema.ts (kept in lockstep with it).
  const expected = JSON.stringify(
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://compositz.dev/schema/compositz.schema.json",
      ...manifestJsonSchema(),
    },
    null,
    2,
  ) + "\n";
  const actual = await Deno.readTextFile(new URL("../spec/compositz.schema.json", import.meta.url));
  assertEquals(actual, expected, "stale JSON Schema — run `deno task schema` to regenerate");
});
