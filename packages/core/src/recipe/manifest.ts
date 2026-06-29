// The Compositz recipe manifest (`compositz.yaml`): a single-container app
// description, kept separate from the Dockerfile (Umbrel-style). Authored in YAML.
//
// This Zod schema is the SINGLE SOURCE OF TRUTH: it is the runtime validator, the
// inferred TypeScript types, AND the source of spec/compositz.schema.json (generated
// via `deno task schema`, which calls manifestJsonSchema()).
//
// Every field maps to a Docker runtime concept (image/build, ports, mounts, env,
// gpu) plus light author metadata (name/description/required) — not a parallel
// config DSL. See docs/recipe-ingestion.md.

import { parse as parseYaml } from "@std/yaml";
import { z } from "zod";
import { CompositzError } from "../errors.ts";

export const MANIFEST_VERSION = 2;

/**
 * The recipe `id` charset — the single source of truth. It keys the image,
 * container, data dirs, and labels, and flows into filesystem paths, so callers
 * that accept an id from outside (e.g. a UI route) MUST validate against this.
 */
export const RECIPE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

const PORT = z.number().int().min(1).max(65535);

// Names flow into host paths (<data-root>/<id>/<name>), volume names, and override
// keys, so they are charset-constrained — no dots or slashes, which blocks path
// traversal and yields valid Docker volume names.
const NAME = z.string().regex(
  /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/,
  "must be alphanumeric/underscore/hyphen, 1-63 chars, starting alphanumeric (no dots or slashes)",
);

/** A POSIX environment variable name (also blocks `=` breaking NAME=value). */
const ENV_NAME = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be a valid env var name");

const GpuSchema = z.enum(["required", "preferred", "none"]).describe(
  "GPU policy: required fails without a GPU; preferred tries GPU then falls back to CPU; none never attaches one.",
);

const BuildSchema = z.strictObject({
  dockerfile: z.string().default("Dockerfile"),
  args: z.record(z.string(), z.string()).optional(),
}).describe("Build the image from a Dockerfile context (mutually exclusive with `image`).");

const PortSchema = z.strictObject({
  name: NAME.describe("Stable key — UI button label and per-install override key."),
  container: PORT.describe("Port the app listens on inside the container."),
  host: PORT.optional().describe(
    "Host port to publish on (default = container; auto-bumped on conflict).",
  ),
  protocol: z.enum(["tcp", "udp"]).default("tcp"),
  web: z.boolean().default(false).describe(
    'Serves a browser UI — renders an "Open UI" button. Multiple allowed.',
  ),
  path: z.string().regex(/^\//, "must start with '/'").default("/").describe(
    "UI path (absolute), used to build the open URL.",
  ),
  description: z.string().optional(),
});

const MountSchema = z.strictObject({
  name: NAME.describe("Stable key — host subdir / volume suffix."),
  target: z.string().regex(/^\//, "must be an absolute path").describe("In-container mount path."),
  placement: z.enum(["bind", "volume"]).default("volume").describe(
    "bind => host <data-root>/<id>/<name> (browsable, slow on Windows); volume => managed named volume.",
  ),
  description: z.string().optional(),
});

const VenvCacheSchema = z.strictObject({
  type: z.literal("venv"),
}).describe(
  "Per-instance uv venv + co-located uv cache on one volume (hardlink-safe). Injects VIRTUAL_ENV + UV_CACHE_DIR.",
);

const HuggingfaceCacheSchema = z.strictObject({
  type: z.literal("huggingface"),
}).describe("Shared HuggingFace hub cache. Injects HF_HOME.");

const CustomCacheSchema = z.strictObject({
  type: z.literal("custom"),
  name: NAME.describe("Cache key (volume suffix)."),
  env: ENV_NAME.describe("Env var the mount path is injected into."),
  scope: z.enum(["shared", "instance"]).default("shared").describe(
    "shared => one cache across apps; instance => a per-(app,instance) subpath.",
  ),
});

const CacheSchema = z.discriminatedUnion("type", [
  VenvCacheSchema,
  HuggingfaceCacheSchema,
  CustomCacheSchema,
]);

const EnvSchema = z.strictObject({
  name: ENV_NAME,
  description: z.string().optional(),
  required: z.boolean().default(false).describe("The user must confirm a value before launch."),
  default: z.string().optional().describe("Suggested/placeholder value (coexists with required)."),
});

const ManifestObject = z.strictObject({
  manifestVersion: z.literal(MANIFEST_VERSION),
  id: z.string().regex(
    RECIPE_ID_PATTERN,
    "must be lowercase alphanumeric/hyphen, 1-63 chars, starting alphanumeric",
  ).describe("Key for image/container/data/labels."),
  name: z.string().regex(/\S/, "must not be blank"),
  // version is used as the Docker image TAG, so it is constrained to the tag charset
  // (also blocks blanks and request-line injection — it reaches the Engine HTTP path).
  version: z.string().regex(
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/,
    "must be a valid image tag (alphanumeric plus . _ -, max 128 chars)",
  ),
  description: z.string().optional(),
  build: BuildSchema.optional(),
  // image reaches the Engine HTTP path unencoded — constrain to a safe ref charset.
  image: z.string().regex(
    /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/,
    "must be a valid image reference",
  ).optional().describe("Prebuilt image reference (mutually exclusive with `build`)."),
  ports: z.array(PortSchema).default([]),
  mounts: z.array(MountSchema).default([]).describe(
    "Persisted data. Declared => kept across restarts.",
  ),
  cache: z.array(CacheSchema).default([]).describe(
    "Opt-in managed caches; paths injected as env vars.",
  ),
  env: z.array(EnvSchema).default([]),
  gpu: GpuSchema.default("preferred"),
}).meta({
  // NOTE: z.toJSONSchema drops meta.id, so the published `$id` is set once in
  // scripts/gen_schema.ts (the single source). Only `title` survives into the schema.
  title: "Compositz recipe manifest",
});

/** The validated manifest schema, including cross-field rules not expressible structurally. */
export const ManifestSchema = ManifestObject.superRefine((m, ctx) => {
  // build XOR image — exactly one image source.
  if (!m.build && !m.image) {
    ctx.addIssue({ code: "custom", message: "one of `build` or `image` is required", path: [] });
  }
  if (m.build && m.image) {
    ctx.addIssue({
      code: "custom",
      message: "`build` and `image` are mutually exclusive",
      path: ["image"],
    });
  }
  // Unique names within each list.
  reportDuplicates(ctx, m.ports, "ports", (p) => p.name);
  reportDuplicates(ctx, m.mounts, "mounts", (mt) => mt.name);
  reportDuplicates(ctx, m.env, "env", (e) => e.name);
  // Two mounts to one in-container target is an invalid spec — reject early.
  const targets = new Set<string>();
  m.mounts.forEach((mt, i) => {
    if (targets.has(mt.target)) {
      ctx.addIssue({
        code: "custom",
        message: `duplicate mount target "${mt.target}"`,
        path: ["mounts", i, "target"],
      });
    }
    targets.add(mt.target);
  });
  // Cache: at most one of each preset; custom keyed by name.
  reportDuplicates(ctx, m.cache, "cache", (c) => c.type === "custom" ? `custom:${c.name}` : c.type);
});

export type GpuMode = z.infer<typeof GpuSchema>;
export type BuildSpec = z.infer<typeof BuildSchema>;
export type PortMapping = z.infer<typeof PortSchema>;
export type MountMapping = z.infer<typeof MountSchema>;
export type CacheSpec = z.infer<typeof CacheSchema>;
export type EnvSpec = z.infer<typeof EnvSchema>;
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
  // Generated from the structural object: cross-field refinements (XOR, uniqueness)
  // are enforced by the Zod validator but have no faithful JSON Schema form.
  return z.toJSONSchema(ManifestObject, { target: "draft-2020-12", io: "input" }) as Record<
    string,
    unknown
  >;
}

function reportDuplicates<T>(
  ctx: z.RefinementCtx,
  items: T[],
  field: string,
  keyOf: (item: T) => string,
): void {
  const seen = new Set<string>();
  items.forEach((item, i) => {
    const key = keyOf(item);
    if (seen.has(key)) {
      ctx.addIssue({
        code: "custom",
        message: `duplicate ${field} entry "${key}"`,
        path: [field, i],
      });
    }
    seen.add(key);
  });
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
