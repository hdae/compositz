// High-level recipe operations shared by the CLI and the desktop app: build the
// image, bring a container up (honoring the GPU tri-state), and tear it down.

import { containerName } from "../brand.ts";
import { tarContext } from "../build.ts";
import type { EngineClient } from "../engine/client.ts";
import type { BuildProgress } from "../engine/types.ts";
import type { Recipe } from "./loader.ts";
import { recipeContainerName, recipeImageTag, toCreateSpec } from "./run.ts";

/** Build the recipe's image, streaming build progress. */
export async function* installRecipe(
  client: EngineClient,
  recipe: Recipe,
): AsyncGenerator<BuildProgress> {
  const tar = await tarContext(recipe.context);
  yield* client.build(tar, {
    tag: recipeImageTag(recipe.manifest),
    dockerfile: recipe.manifest.build.dockerfile,
    buildArgs: recipe.manifest.build.args,
  });
}

export interface UpResult {
  id: string;
  usedGpu: boolean;
}

/**
 * Create + start a container from the recipe, replacing any prior instance.
 * GPU tri-state: `required` insists on GPU, `none` never attaches it, and
 * `preferred` tries with GPU and transparently falls back to CPU on failure.
 */
export async function up(client: EngineClient, recipe: Recipe): Promise<UpResult> {
  const m = recipe.manifest;
  const name = recipeContainerName(m);
  await client.remove(name, { force: true }).catch(() => {});

  const startWith = async (withGpu: boolean): Promise<string> => {
    const { Id } = await client.create(toCreateSpec(m, { withGpu }), name);
    await client.start(Id);
    return Id;
  };

  if (m.gpu === "none") return { id: await startWith(false), usedGpu: false };
  if (m.gpu === "required") return { id: await startWith(true), usedGpu: true };

  // preferred: try GPU, fall back to CPU.
  try {
    return { id: await startWith(true), usedGpu: true };
  } catch {
    await client.remove(name, { force: true }).catch(() => {});
    return { id: await startWith(false), usedGpu: false };
  }
}

/** Stop and remove a recipe's container (no-op if absent). */
export async function down(
  client: EngineClient,
  recipeId: string,
  opts: { stopTimeout?: number } = {},
): Promise<void> {
  const name = containerName(recipeId);
  await client.stop(name, opts.stopTimeout).catch(() => {});
  await client.remove(name, { force: true }).catch(() => {});
}
