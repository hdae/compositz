import {
  deconflictHostPorts,
  effectiveHostPort,
  type Instance,
  instanceImageTag,
  loadInstanceConfig,
  type PortBump,
} from "@compositz/core";
import type { InstanceView } from "./dashboard.ts";

// SERVER-ONLY: imports runtime values from @compositz/core, so it must never be imported
// by an island / client code (only route handlers + the index route). It is the SINGLE
// mapping from a core `Instance` to the dashboard view-model — shared by the initial
// render (routes/index.tsx) and both import routes (file upload + GitHub) so the view
// shape cannot silently drift between them.

/**
 * Build the dashboard view-model for a loaded / freshly-ingested instance. Loads the
 * per-instance override so each web port carries its effective DEFINED host port
 * (override ▷ manifest) — the fallback the Services list uses before a live port is known.
 */
export async function toInstanceView(instance: Instance): Promise<InstanceView> {
  const m = instance.manifest;
  const override = await loadInstanceConfig(instance.dir);
  return {
    instanceId: instance.instanceId,
    appId: instance.appId,
    name: m.name,
    version: m.version,
    description: m.description ?? "",
    webPorts: m.ports.filter((p) => p.web).map((p) => ({
      name: p.name,
      container: p.container,
      protocol: p.protocol,
      path: p.path,
      host: effectiveHostPort(p, override.hostPorts),
      description: p.description,
    })),
    imageTag: instanceImageTag(m, instance.instanceId),
  };
}

/**
 * Finalize a freshly-created instance for an import response: deconflict its host ports
 * against the other instances' definitions (persists any reassignment to its config.yaml)
 * and build the view AFTER, so it reflects the assigned ports. Returns the bumps so the
 * trust prompt can notify the user of any reassignment. Shared by both import routes.
 */
export async function finalizeImport(
  store: string,
  instance: Instance,
): Promise<{ view: InstanceView; bumps: PortBump[] }> {
  const bumps = await deconflictHostPorts(store, instance);
  const view = await toInstanceView(instance); // re-reads config.yaml → reflects the bumps
  return { view, bumps };
}
