// Client-side view-model merge — the React port of what core's `view.rs` does
// server-side (`instance_services` + the container→row join in `to_instance_rows`).
//
// Why it lives here too: `list_instance_rows` returns rows already joined with an
// engine snapshot at fetch time, but the live `subscribe_instances` stream pushes
// only RAW container statuses (no `installed_tags`). So the client keeps the base
// rows and re-derives `running` / `services` from each snapshot, exactly as core
// would — one shared derivation shape, expressed twice against the same typed
// contract. See view.rs:`instance_services` / `to_instance_rows` for the source.

import type { ContainerStatus, InstanceRow, PublishedPort, Service, WebPort } from "@/ipc/bindings";

/**
 * The live engine state as the snapshot stream reports it.
 * - `connecting` — subscribed, no snapshot yet (seed state).
 * - `online` — a `snapshot` event with the managed containers.
 * - `offline` — an `offline` event; the engine is unreachable (installed unknown).
 */
export type LiveSnapshot =
  | { kind: "connecting" }
  | { kind: "online"; containers: ContainerStatus[] }
  | { kind: "offline"; error: string };

/**
 * List EVERY declared web port, resolving each host port by precedence:
 * **live published ▷ defined (override ▷ manifest)**. Mirrors core `instance_services`:
 * the live port wins for DISPLAY because it is where the container actually is; with
 * no live binding the defined port (`wp.host`) is the expected endpoint, `ready:false`.
 * `ready` needs an explicit probe `accepting === true` — a published-but-warming port
 * is live-for-display yet never "ready".
 */
export function deriveServices(webPorts: WebPort[], livePorts: PublishedPort[]): Service[] {
  return webPorts.map((wp) => {
    const live = livePorts.find((p) => p.container === wp.container && p.protocol === wp.protocol);
    const port = live?.public ?? wp.host;
    return {
      name: wp.name,
      path: wp.path,
      description: wp.description,
      port,
      url: `http://localhost:${port}${wp.path}`,
      ready: live?.accepting === true,
    };
  });
}

/**
 * Overlay the live snapshot onto a base row, re-deriving `running`, `services`, and
 * `installed`. Mirrors core `to_instance_rows`'s per-row join.
 *
 * `installedOverride` carries the ONE thing the snapshot stream cannot: a row flips to
 * installed the moment its `instance_install` reports `done` (the stream never carries
 * `installed_tags`). Offline forces `installed: null` (unknown), like a `None` snapshot.
 */
export function mergeRow(
  base: InstanceRow,
  snapshot: LiveSnapshot,
  installedOverride: Record<string, boolean>,
): InstanceRow {
  // `??` (not `||`) so a genuine base `false` is kept; the override is only ever set
  // to `true`, so this never swallows a meaningful value.
  const installed = installedOverride[base.instanceId] ?? base.installed;

  if (snapshot.kind === "offline") {
    return {
      ...base,
      running: false,
      services: deriveServices(base.webPorts, []),
      installed: null,
    };
  }
  if (snapshot.kind === "connecting") {
    return { ...base, running: false, services: deriveServices(base.webPorts, []), installed };
  }
  const container = snapshot.containers.find(
    (c) => c.instance === base.instanceId && c.state === "running",
  );
  return {
    ...base,
    running: container !== undefined,
    services: deriveServices(base.webPorts, container?.ports ?? []),
    installed,
  };
}
