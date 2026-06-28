// Generate spec/compositz.schema.json from the Zod manifest schema.
// Run with: deno task schema
import { manifestJsonSchema } from "@compositz/core";

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://compositz.dev/schema/compositz.schema.json",
  ...manifestJsonSchema(),
};

const out = "spec/compositz.schema.json";
await Deno.writeTextFile(out, JSON.stringify(schema, null, 2) + "\n");
console.log(`wrote ${out}`);
