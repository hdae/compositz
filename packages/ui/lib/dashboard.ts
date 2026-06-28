// Pure view-model derivation for the recipe dashboard — shared by the server
// (initial render) and the client island (live SSE updates).
//
// Deliberately free of any runtime `@compositz/core` value import (only the
// `ContainerSummary` *type*, erased at compile time), so it is safe to bundle
// into an island and testable without Docker. The engine I/O lives in
// server-only route handlers (routes/api/*). See routes/index.tsx.

import type { ContainerSummary } from "@compositz/core";

/** A recipe reduced to the fields the dashboard renders (built by the handler). */
export type RecipeView = {
  id: string;
  name: string;
  version: string;
  description: string;
  /** Local web UI URL, if the recipe publishes one. */
  web: string | null;
  /** The image tag this recipe builds to (e.g. compositz/hello-web:0.1.0). */
  imageTag: string;
};

/**
 * A managed container reduced to what the dashboard needs — slim enough to push
 * over SSE as JSON. `recipe` is the recipe id carried by the container label
 * (null if absent); `state` is Docker's container state ("running", "exited", …).
 */
export type ContainerStatus = {
  recipe: string | null;
  state: string;
};

/** A live read of the engine: managed containers + which image tags exist locally. */
export type EngineSnapshot = {
  containers: ContainerStatus[];
  /** Image tags that exist locally (kept as an array so it serializes for props/SSE). */
  installedTags: string[];
};

/** One rendered dashboard row: a recipe plus its derived runtime status. */
export type RecipeRow = {
  id: string;
  name: string;
  version: string;
  description: string;
  web: string | null;
  /** Image built locally? `null` when the engine is unreachable (unknown). */
  installed: boolean | null;
  /** A managed container for this recipe is in the "running" state. */
  running: boolean;
};

/**
 * Map raw engine container summaries to the slim {@link ContainerStatus} shape.
 * Server-only in practice (the input comes from `EngineClient.ps`), but pure.
 *
 * @param recipeLabelKey the container label that carries a recipe id
 *   (e.g. `io.compositz.recipe`).
 */
export function toContainerStatuses(
  summaries: ContainerSummary[],
  recipeLabelKey: string,
): ContainerStatus[] {
  return summaries.map((c) => ({
    recipe: c.Labels[recipeLabelKey] ?? null,
    state: c.State,
  }));
}

/**
 * Derive dashboard rows from recipes and an optional engine snapshot.
 *
 * When `snapshot` is `null` the engine was unreachable: installed status is
 * unknown (`null`) and nothing is reported running, but recipes still list.
 */
export function toRecipeRows(
  recipes: RecipeView[],
  snapshot: EngineSnapshot | null,
): RecipeRow[] {
  return recipes.map((r) => {
    const base = {
      id: r.id,
      name: r.name,
      version: r.version,
      description: r.description,
      web: r.web,
    };
    if (snapshot === null) {
      return { ...base, installed: null, running: false };
    }
    const running = snapshot.containers.some(
      (c) => c.recipe === r.id && c.state === "running",
    );
    return { ...base, installed: snapshot.installedTags.includes(r.imageTag), running };
  });
}
