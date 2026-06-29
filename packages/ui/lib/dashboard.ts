// Pure view-model derivation for the instance dashboard — shared by the server
// (initial render) and the client island (live SSE updates).
//
// Deliberately free of any runtime `@compositz/core` value import (only the
// `ContainerSummary` *type*, erased at compile time), so it is safe to bundle
// into an island and testable without Docker. The engine I/O lives in
// server-only route handlers (routes/api/*). See routes/index.tsx.

import type { ContainerSummary } from "@compositz/core";

/** An instance reduced to the fields the dashboard renders (built by the handler). */
export type InstanceView = {
  /** The runtime key — actions and status match on this. */
  instanceId: string;
  /** The app (manifest id) this instance runs — a slug, for display/grouping. */
  appId: string;
  name: string;
  version: string;
  description: string;
  /** Local web UI URL, if the instance publishes one. */
  web: string | null;
  /** The image tag this instance builds to (e.g. compositz/hello-a1b2c3:0.1.0). */
  imageTag: string;
};

/**
 * A managed container reduced to what the dashboard needs — slim enough to push
 * over SSE as JSON. `instance` is the instance id carried by the container label
 * (null if absent); `state` is Docker's container state ("running", "exited", …).
 */
export type ContainerStatus = {
  instance: string | null;
  state: string;
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
  web: string | null;
  /** Image built locally? `null` when the engine is unreachable (unknown). */
  installed: boolean | null;
  /** A managed container for this instance is in the "running" state. */
  running: boolean;
};

/**
 * Map raw engine container summaries to the slim {@link ContainerStatus} shape.
 * Server-only in practice (the input comes from `EngineClient.ps`), but pure.
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
  }));
}

/**
 * Derive dashboard rows from instances and an optional engine snapshot.
 *
 * When `snapshot` is `null` the engine was unreachable: installed status is
 * unknown (`null`) and nothing is reported running, but instances still list.
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
      web: v.web,
    };
    if (snapshot === null) {
      return { ...base, installed: null, running: false };
    }
    const running = snapshot.containers.some(
      (c) => c.instance === v.instanceId && c.state === "running",
    );
    return { ...base, installed: snapshot.installedTags.includes(v.imageTag), running };
  });
}

/**
 * Fold a just-confirmed up/down action into a container snapshot, so the UI
 * reflects the new state the moment the POST resolves (the operation is complete
 * server-side) instead of waiting up to one SSE poll — which otherwise flickers
 * the button back to its old label. The next real snapshot reconciles.
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
  return action === "up" ? [...others, { instance: instanceId, state: "running" }] : others;
}
