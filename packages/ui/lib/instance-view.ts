import { type Instance, instanceImageTag } from "@compositz/core";
import type { InstanceView } from "./dashboard.ts";

// SERVER-ONLY: imports a runtime value (`instanceImageTag`) from @compositz/core, so it
// must never be imported by an island / client code (only route handlers + the index
// route). It is the SINGLE mapping from a core `Instance` to the dashboard view-model —
// shared by the initial render (routes/index.tsx) and both import routes (file upload +
// GitHub) so the view shape cannot silently drift between them.

/** Build the dashboard view-model for a loaded / freshly-ingested instance. */
export function toInstanceView(instance: Instance): InstanceView {
  const m = instance.manifest;
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
      description: p.description,
    })),
    imageTag: instanceImageTag(m, instance.instanceId),
  };
}
