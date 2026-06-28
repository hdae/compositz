// Pure view-model derivation for the recipe dashboard.
//
// This module is deliberately free of any runtime `@compositz/core` value
// import (only the `ContainerSummary` *type*, which is erased at compile time).
// The engine/recipe I/O lives in the server-only route handler; this file just
// turns the fetched data into rows, so it is testable without Docker and safe to
// pull into any bundle. See routes/index.tsx for the I/O side.

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

/** A live read of the engine: managed containers + which image tags exist. */
export type EngineSnapshot = {
  containers: ContainerSummary[];
  installedTags: Set<string>;
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

/** The full payload the index route hands to its page component. */
export type Dashboard = {
  recipes: RecipeRow[];
  engineOnline: boolean;
  /** Human-readable reason the engine was unreachable, when offline. */
  engineError: string | null;
};

/**
 * Derive dashboard rows from recipes and an optional engine snapshot.
 *
 * When `snapshot` is `null` the engine was unreachable: installed status is
 * unknown (`null`) and nothing is reported running, but recipes still list.
 *
 * @param recipeLabelKey the container label that carries a recipe id
 *   (e.g. `io.compositz.recipe`), used to match containers to recipes.
 */
export function toRecipeRows(
  recipes: RecipeView[],
  snapshot: EngineSnapshot | null,
  recipeLabelKey: string,
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
      (c) => c.Labels[recipeLabelKey] === r.id && c.State === "running",
    );
    return { ...base, installed: snapshot.installedTags.has(r.imageTag), running };
  });
}
