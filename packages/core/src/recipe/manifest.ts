// The Compositz recipe manifest (`compositz.yaml`): a single-container app
// description, kept separate from the Dockerfile (Umbrel-style). Authored in YAML.
//
// This Zod schema is the SINGLE SOURCE OF TRUTH: it is the runtime validator, the
// inferred TypeScript types, AND the source of spec/compositz.schema.json (generated
// via `deno task schema`, which calls manifestJsonSchema()).

import { parse as parseYaml } from "@std/yaml";
import { z } from "zod";
import { CompositzError } from "../errors.ts";

export const MANIFEST_VERSION = 1;

const PORT = z.number().int().min(1).max(65535);

const GpuSchema = z.enum(["required", "preferred", "none"]).describe(
  "GPU policy: required fails without a GPU; preferred tries GPU then falls back to CPU; none never attaches one.",
);

const BuildSchema = z.strictObject({
  dockerfile: z.string().default("Dockerfile"),
  args: z.record(z.string(), z.string()).optional(),
});

const WebSchema = z.strictObject({
  port: PORT.describe("Container port serving the web UI."),
  hostPort: PORT.optional().describe("Host port to publish it on (default = port)."),
  path: z.string().default("/"),
}).describe("The container's primary web UI.");

const PortSchema = z.strictObject({
  container: PORT,
  host: PORT.optional(),
  protocol: z.enum(["tcp", "udp"]).default("tcp"),
});

const VolumeSchema = z.strictObject({
  name: z.string().min(1),
  target: z.string().min(1),
});

export const ManifestSchema = z.strictObject({
  manifestVersion: z.literal(MANIFEST_VERSION),
  id: z.string().regex(
    /^[a-z0-9][a-z0-9-]{0,62}$/,
    "must be lowercase alphanumeric/hyphen, 1-63 chars, starting alphanumeric",
  ),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().optional(),
  build: BuildSchema.default({ dockerfile: "Dockerfile" }),
  web: WebSchema.optional(),
  ports: z.array(PortSchema).default([]).describe("Additional ports to publish (besides web)."),
  env: z.array(z.string().regex(/=/, 'must be "NAME=value"')).default([]),
  volumes: z.array(VolumeSchema).default([]),
  gpu: GpuSchema.default("preferred"),
}).meta({
  id: "https://compositz.dev/schema/compositz.schema.json",
  title: "Compositz recipe manifest",
});

export type GpuMode = z.infer<typeof GpuSchema>;
export type BuildSpec = z.infer<typeof BuildSchema>;
export type WebSpec = z.infer<typeof WebSchema>;
export type PortMapping = z.infer<typeof PortSchema>;
export type VolumeMapping = z.infer<typeof VolumeSchema>;
export type Manifest = z.infer<typeof ManifestSchema>;

/** Parse + validate a manifest from YAML text. Throws CompositzError on any problem. */
export function parseManifest(yamlText: string): Manifest {
  let doc: unknown;
  try {
    doc = parseYaml(yamlText);
  } catch (e) {
    throw new CompositzError(`manifest is not valid YAML: ${e instanceof Error ? e.message : e}`);
  }
  const result = ManifestSchema.safeParse(doc);
  if (!result.success) throw new CompositzError(formatIssues(result.error));
  return result.data;
}

/** The manifest schema as a JSON Schema document (for recipe authors / agents). */
export function manifestJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ManifestSchema, { target: "draft-2020-12", io: "input" }) as Record<
    string,
    unknown
  >;
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `manifest.${pathOf(i.path)} ${i.message}`).join("; ");
}

function pathOf(path: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else out += out ? `.${String(seg)}` : String(seg);
  }
  return out || "(root)";
}
