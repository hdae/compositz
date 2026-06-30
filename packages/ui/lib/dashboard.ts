// Pure view-model derivation for the instance dashboard — shared by the server
// (initial render) and the client island (live SSE updates).
//
// Deliberately free of any runtime `@compositz/core` value import (only the
// `ContainerSummary` *type*, erased at compile time), so it is safe to bundle
// into an island and testable without Docker. The engine I/O lives in
// server-only route handlers (routes/api/*). See routes/index.tsx.

import type { ContainerSummary } from "@compositz/core";

/** A manifest port that serves a browser UI (`web: true`). An app may declare many. */
export type WebPort = {
  /** Stable port name (label + override key). */
  name: string;
  /** Port inside the container — joined to a running container's published port. */
  container: number;
  protocol: string;
  /** Absolute UI path appended to the URL. */
  path: string;
  /** Effective DEFINED host port (override ▷ manifest host ▷ container) — the fallback
   * when no live published port is known yet. */
  host: number;
  description?: string;
};

/** A container port that the engine has actually published to the host. */
export type PublishedPort = {
  container: number;
  public: number;
  protocol: string;
};

/**
 * A declared web endpoint resolved to a host port. The port is the LIVE published port
 * when known (authoritative — it reflects an unrestarted instance still on its old port,
 * and an engine auto-bump), else the DEFINED port (override ▷ manifest). `ready` is true
 * once the live binding is confirmed in `ps`; while still starting it is false and the
 * `port`/`url` show the *expected* (defined) endpoint rather than blank.
 */
export type Service = {
  name: string;
  path: string;
  description?: string;
  /** Host port: live published ▷ defined (override ▷ manifest). */
  port: number;
  /** Openable URL built from `port` + path. */
  url: string;
  /** The live binding is confirmed in `ps` (vs. the still-starting expected endpoint). */
  ready: boolean;
};

/** An instance reduced to the fields the dashboard renders (built by the handler). */
export type InstanceView = {
  /** The runtime key — actions and status match on this. */
  instanceId: string;
  /** The app (manifest id) this instance runs — a slug, for display/grouping. */
  appId: string;
  name: string;
  version: string;
  description: string;
  /** Declared web ports (`web: true`). Live URLs are resolved against the container. */
  webPorts: WebPort[];
  /** The image tag this instance builds to (e.g. compositz/hello-a1b2c3:0.1.0). */
  imageTag: string;
};

// --- per-instance settings (RI-4 override editor) --------------------------
// The Settings editor view-model: each manifest item with its author default and the
// saved override (if any). Built server-side from manifest ⊕ config.yaml; the island
// renders it into an editable form and PUTs back only the values that differ from the
// defaults. Port conflicts are checked CLIENT-side against `takenByOthers` (the host
// ports DEFINED by other instances), so the warning recomputes live as the user types.

/** A host port reassigned at add time to avoid a collision (shown in the trust prompt). */
export type PortBump = { name: string; from: number; to: number };

/** One manifest port in the Settings editor: author default + saved override. */
export type PortSetting = {
  name: string;
  container: number;
  web: boolean;
  description?: string;
  /** Manifest default host port (`p.host ?? p.container`). */
  manifestHost: number;
  /** Saved host-port override, if any. */
  override?: number;
};

/** One manifest env var in the Settings editor. */
export type EnvSetting = {
  name: string;
  description?: string;
  required: boolean;
  /** Manifest default / placeholder value. */
  default?: string;
  /** Saved value override, if any. */
  override?: string;
};

/** One manifest mount in the Settings editor (placement is the only override). */
export type MountSetting = {
  name: string;
  target: string;
  description?: string;
  manifestPlacement: "bind" | "volume";
  override?: "bind" | "volume";
};

/** The Settings editor view-model for one instance (manifest ⊕ saved override). */
export type InstanceSettings = {
  ports: PortSetting[];
  env: EnvSetting[];
  mounts: MountSetting[];
  /** Host ports DEFINED by OTHER instances — the client checks port conflicts against this. */
  takenByOthers: number[];
};

/**
 * A managed container reduced to what the dashboard needs — slim enough to push
 * over SSE as JSON. `instance` is the instance id carried by the container label
 * (null if absent); `state` is Docker's container state ("running", "exited", …);
 * `ports` are the host-published port bindings (for resolving live service URLs).
 */
export type ContainerStatus = {
  instance: string | null;
  state: string;
  ports: PublishedPort[];
};

/** A live read of the engine: managed containers + which image tags exist locally. */
export type EngineSnapshot = {
  containers: ContainerStatus[];
  /** Image tags that exist locally (kept as an array so it serializes for props/SSE). */
  installedTags: string[];
};

/** One rendered dashboard row: an instance plus its derived runtime status. */
export type InstanceRow = {
  instanceId: string;
  appId: string;
  name: string;
  version: string;
  description: string;
  webPorts: WebPort[];
  /** Declared services, always listed from the definition; the live port fills in when running. */
  services: Service[];
  /** Image built locally? `null` when the engine is unreachable (unknown). */
  installed: boolean | null;
  /** A managed container for this instance is in the "running" state. */
  running: boolean;
};

/**
 * Map raw engine container summaries to the slim {@link ContainerStatus} shape,
 * keeping only host-published ports (those carry a `PublicPort`). Server-only in
 * practice (the input comes from `EngineClient.ps`), but pure.
 *
 * @param instanceLabelKey the container label that carries an instance id
 *   (e.g. `io.compositz.instance`).
 */
export function toContainerStatuses(
  summaries: ContainerSummary[],
  instanceLabelKey: string,
): ContainerStatus[] {
  return summaries.map((c) => ({
    instance: c.Labels[instanceLabelKey] ?? null,
    state: c.State,
    ports: c.Ports.filter((p) => p.PublicPort != null).map((p) => ({
      container: p.PrivatePort,
      public: p.PublicPort!,
      protocol: p.Type,
    })),
  }));
}

/**
 * List EVERY declared web port, resolving each host port by precedence:
 * **live published ▷ defined (override ▷ manifest)**. The live port wins when known
 * because it is what the container is ACTUALLY on — covering an instance whose override
 * changed but wasn't restarted yet, and an engine auto-bump. When no live binding has
 * appeared in `ps` yet (the starting window), fall back to the defined port (`wp.host`)
 * so the row shows the *expected* endpoint instead of a blank, with `ready: false`.
 */
export function instanceServices(webPorts: WebPort[], ports: PublishedPort[]): Service[] {
  return webPorts.map((wp) => {
    const live = ports.find((p) => p.container === wp.container && p.protocol === wp.protocol)
      ?.public;
    const port = live ?? wp.host;
    return {
      name: wp.name,
      path: wp.path,
      description: wp.description,
      port,
      url: `http://localhost:${port}${wp.path}`,
      ready: live !== undefined,
    };
  });
}

/**
 * Derive dashboard rows from instances and an optional engine snapshot.
 *
 * Services are ALWAYS listed from the definition (manifest ⊕ override) — so the user can
 * see a recipe's web endpoints before starting it. The live published port fills in (and
 * the service becomes openable) once a running container publishes it. When `snapshot` is
 * `null` the engine was unreachable: installed is unknown (`null`), nothing is running.
 */
export function toInstanceRows(
  views: InstanceView[],
  snapshot: EngineSnapshot | null,
): InstanceRow[] {
  return views.map((v) => {
    const base = {
      instanceId: v.instanceId,
      appId: v.appId,
      name: v.name,
      version: v.version,
      description: v.description,
      webPorts: v.webPorts,
    };
    if (snapshot === null) {
      return {
        ...base,
        installed: null,
        running: false,
        services: instanceServices(v.webPorts, []),
      };
    }
    const container = snapshot.containers.find(
      (c) => c.instance === v.instanceId && c.state === "running",
    );
    return {
      ...base,
      installed: snapshot.installedTags.includes(v.imageTag),
      running: container !== undefined,
      services: instanceServices(v.webPorts, container?.ports ?? []),
    };
  });
}

/**
 * Fold a just-confirmed up/down action into a container snapshot, so the UI
 * reflects the new state the moment the POST resolves (the operation is complete
 * server-side) instead of waiting up to one SSE poll — which otherwise flickers
 * the button back to its old label. The next real snapshot reconciles (and brings
 * the published ports, which the optimistic entry can't know yet).
 *
 * `up` ⇒ exactly one running container for the instance; `down` ⇒ none. Other
 * instances' containers are untouched.
 */
export function withOptimisticAction(
  containers: ContainerStatus[],
  instanceId: string,
  action: "up" | "down",
): ContainerStatus[] {
  const others = containers.filter((c) => c.instance !== instanceId);
  return action === "up"
    ? [...others, { instance: instanceId, state: "running", ports: [] }]
    : others;
}
