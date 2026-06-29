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
  description?: string;
};

/** A container port that the engine has actually published to the host. */
export type PublishedPort = {
  container: number;
  public: number;
  protocol: string;
};

/** A live, openable web endpoint: a declared web port matched to its live host port. */
export type Service = {
  name: string;
  url: string;
  port: number;
  description?: string;
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
  /** Live openable services (empty unless a running container publishes the ports). */
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
 * Resolve a declared web port to a live, openable URL by matching it to a running
 * container's published ports (container port + protocol). The manifest's declared
 * host port is only a *desired* value (it can be auto-bumped on conflict), so the
 * authoritative host port is the engine's published one — never the manifest's.
 * Ports with no live binding are omitted (the service isn't reachable yet).
 */
export function instanceServices(webPorts: WebPort[], ports: PublishedPort[]): Service[] {
  return webPorts.flatMap((wp) => {
    const pub = ports.find((p) => p.container === wp.container && p.protocol === wp.protocol);
    if (!pub) return [];
    return [{
      name: wp.name,
      url: `http://localhost:${pub.public}${wp.path}`,
      port: pub.public,
      description: wp.description,
    }];
  });
}

/**
 * Derive dashboard rows from instances and an optional engine snapshot.
 *
 * When `snapshot` is `null` the engine was unreachable: installed status is
 * unknown (`null`), nothing is running, and no services resolve, but instances
 * still list.
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
      return { ...base, installed: null, running: false, services: [] };
    }
    const container = snapshot.containers.find(
      (c) => c.instance === v.instanceId && c.state === "running",
    );
    const services = container ? instanceServices(v.webPorts, container.ports) : [];
    return {
      ...base,
      installed: snapshot.installedTags.includes(v.imageTag),
      running: container !== undefined,
      services,
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
