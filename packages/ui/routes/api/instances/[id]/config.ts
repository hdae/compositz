import {
  definedHostPorts,
  type Instance,
  INSTANCE_ID_PATTERN,
  instancesDir,
  loadInstance,
  loadInstanceConfig,
  loadLaunchedConfig,
  type Override,
  OverrideSchema,
  sameOverride,
  saveInstanceConfig,
} from "@compositz/core";
import { join } from "@std/path";
import { define } from "../../../../utils.ts";
import type { InstanceSettings } from "../../../../lib/dashboard.ts";

// SERVER-ONLY: imports @compositz/core (→ node:net + filesystem). The per-instance
// launch-override editor (RI-4):
//   GET  → the Settings view-model (each manifest port/env/mount with its default + the
//          saved override) built from manifest ⊕ config.yaml, plus the host ports DEFINED
//          by OTHER instances (the client checks port conflicts against this — definition-
//          based, not the live engine state, so it catches stopped instances).
//   PUT  → validate the override (Zod + keys must match manifest names) and persist it
//          to config.yaml. It takes effect on the next `up` (loaded there).
// The island fetches on tab-open (server-confirmed) and PUTs the delta on Save.

const store = instancesDir();

/** A 400-worthy bad request (distinct from a 500 engine/OS error). */
class CompositzBadRequest extends Error {}

function loadById(id: string): Promise<Instance> {
  if (!INSTANCE_ID_PATTERN.test(id)) throw new CompositzBadRequest(`invalid instance id: ${id}`);
  return loadInstance(join(store, id));
}

async function buildSettings(instance: Instance, override: Override): Promise<InstanceSettings> {
  const m = instance.manifest;
  return {
    ports: m.ports.map((p) => ({
      name: p.name,
      container: p.container,
      web: p.web,
      description: p.description,
      manifestHost: p.host ?? p.container,
      override: override.hostPorts?.[p.name],
    })),
    env: m.env.map((e) => ({
      name: e.name,
      description: e.description,
      required: e.required,
      default: e.default,
      override: override.env?.[e.name],
    })),
    mounts: m.mounts.map((mt) => ({
      name: mt.name,
      target: mt.target,
      description: mt.description,
      manifestPlacement: mt.placement,
      override: override.placement?.[mt.name],
    })),
    // ports DEFINED by other instances (manifest ⊕ override) — excludes this instance's own.
    takenByOthers: await definedHostPorts(store, instance.instanceId),
    // a restart is needed iff the instance is launched and its saved config has diverged.
    restartNeeded: await restartNeeded(instance, override),
  };
}

/** The saved override differs from what the (running) instance was last launched with. */
async function restartNeeded(instance: Instance, saved: Override): Promise<boolean> {
  const launched = await loadLaunchedConfig(instance.dir);
  return launched !== undefined && !sameOverride(saved, launched);
}

/** Reject any override key that does not name a manifest port / env / mount. */
function assertKnownKeys(instance: Instance, override: Override): void {
  const m = instance.manifest;
  const check = (keys: string[], known: Set<string>, kind: string) => {
    for (const k of keys) {
      if (!known.has(k)) throw new CompositzBadRequest(`unknown ${kind} "${k}"`);
    }
  };
  check(Object.keys(override.hostPorts ?? {}), new Set(m.ports.map((p) => p.name)), "port");
  check(Object.keys(override.env ?? {}), new Set(m.env.map((e) => e.name)), "env");
  check(Object.keys(override.placement ?? {}), new Set(m.mounts.map((mt) => mt.name)), "mount");
}

export const handler = define.handlers({
  async GET(ctx) {
    try {
      const instance = await loadById(ctx.params.id);
      const override = await loadInstanceConfig(instance.dir);
      return Response.json({ ok: true, settings: await buildSettings(instance, override) });
    } catch (e) {
      return fail(e);
    }
  },

  async PUT(ctx) {
    try {
      const instance = await loadById(ctx.params.id);
      const body = await ctx.req.json().catch(() => null);
      const parsed = OverrideSchema.safeParse(body);
      if (!parsed.success) {
        throw new CompositzBadRequest(parsed.error.issues.map((i) => i.message).join("; "));
      }
      assertKnownKeys(instance, parsed.data);
      await saveInstanceConfig(instance.dir, parsed.data);
      return Response.json({ ok: true, restartNeeded: await restartNeeded(instance, parsed.data) });
    } catch (e) {
      return fail(e);
    }
  },
});

function fail(e: unknown): Response {
  const status = e instanceof CompositzBadRequest ? 400 : 500;
  return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, {
    status,
  });
}
