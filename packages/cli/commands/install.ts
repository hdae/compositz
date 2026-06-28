import { EngineClient, installRecipe, recipeImageTag } from "@compositz/core";
import { bold, dim, green, red } from "@std/fmt/colors";
import { resolveRecipe } from "../lib.ts";

/** Build a recipe's image from its Dockerfile + context. */
export async function install(args: string[]): Promise<number> {
  if (!args[0]) {
    console.error(red("usage: compositz install <recipe>"));
    return 1;
  }
  const recipe = await resolveRecipe(args[0]);
  const client = new EngineClient();
  const enc = new TextEncoder();

  console.log(bold(`installing ${recipe.manifest.name}`) + dim(` (${recipe.id})`));
  for await (const p of installRecipe(client, recipe)) {
    if (p.stream) await Deno.stdout.write(enc.encode(p.stream));
    if (p.aux?.ID) console.log(dim(`  image ${p.aux.ID.slice(0, 19)}…`));
  }
  console.log(green(`OK — built ${recipeImageTag(recipe.manifest)}`));
  return 0;
}
