// The per-instance launch override (`config.yaml`): the user's customizations layered
// over the manifest's author defaults (ADR-014, RI-4). It carries ONLY values — host-
// port remaps, env values, and per-mount placement — each keyed by the manifest `name`.
// The manifest is never mutated; at `up` the effective spec is derived from
// manifest ⊕ override (see run.ts `mergeLaunch` / `toCreateSpec`).
//
// NOTE: `dataRoot` is intentionally NOT part of the persisted override — it is a global
// concern (one data-root for the install), deferred to a future settings.yaml; `up`
// supplies the default. So this is a strict SUBSET of run.ts's in-memory `LaunchConfig`.

import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { z } from "zod";
import { CompositzError } from "../errors.ts";

const HOST_PORT = z.number().int().min(1).max(65535);

/** The persisted per-instance override — a strict subset of run.ts's `LaunchConfig`. */
export const OverrideSchema = z.strictObject({
  /** Host-port remap, keyed by port `name`. */
  hostPorts: z.record(z.string(), HOST_PORT).optional(),
  /** Env value override, keyed by env `name`. */
  env: z.record(z.string(), z.string()).optional(),
  /** Placement override, keyed by mount `name`. */
  placement: z.record(z.string(), z.enum(["bind", "volume"])).optional(),
});

export type Override = z.infer<typeof OverrideSchema>;

/** Parse + validate an override from `config.yaml` text. Throws CompositzError on any problem. */
export function parseOverride(yamlText: string): Override {
  let doc: unknown;
  try {
    doc = parseYaml(yamlText);
  } catch (e) {
    throw new CompositzError(`config is not valid YAML: ${e instanceof Error ? e.message : e}`);
  }
  // An empty file (parseYaml → null/undefined) is a valid empty override.
  const result = OverrideSchema.safeParse(doc ?? {});
  if (!result.success) throw new CompositzError(formatIssues(result.error));
  return result.data;
}

/** Structural equality of two overrides — ignores key order and empty-vs-absent sections. */
export function sameOverride(a: Override, b: Override): boolean {
  const sorted = <T>(r?: Record<string, T>) =>
    Object.entries(r ?? {}).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  const norm = (o: Override) =>
    JSON.stringify({
      hostPorts: sorted(o.hostPorts),
      env: sorted(o.env),
      placement: sorted(o.placement),
    });
  return norm(a) === norm(b);
}

/** Serialize an override to `config.yaml` text, dropping empty sections for a clean file. */
export function serializeOverride(override: Override): string {
  const out: Override = {};
  if (override.hostPorts && Object.keys(override.hostPorts).length) {
    out.hostPorts = override.hostPorts;
  }
  if (override.env && Object.keys(override.env).length) out.env = override.env;
  if (override.placement && Object.keys(override.placement).length) {
    out.placement = override.placement;
  }
  return stringifyYaml(out);
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `config.${pathOf(i.path)} ${i.message}`).join("; ");
}

function pathOf(path: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else out += out ? `.${String(seg)}` : String(seg);
  }
  return out || "(root)";
}
