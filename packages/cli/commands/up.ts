import { EngineClient, installRecipe, recipeImageTag, up, webUrl } from "@compositz/core";
import { bold, cyan, dim, green, red } from "@std/fmt/colors";
import { resolveRecipe } from "../lib.ts";

/** Bring a recipe up: build the image if missing, then create + start it. */
export async function upCmd(args: string[]): Promise<number> {
  if (!args[0]) {
    console.error(red("usage: compositz up <recipe>"));
    return 1;
  }
  const recipe = await resolveRecipe(args[0]);
  const client = new EngineClient();
  const enc = new TextEncoder();

  if (!(await client.imageExists(recipeImageTag(recipe.manifest)))) {
    console.log(dim("image not built yet — building…"));
    for await (const p of installRecipe(client, recipe)) {
      if (p.stream) await Deno.stdout.write(enc.encode(p.stream));
    }
  }

  console.log(bold(`starting ${recipe.manifest.name}`));
  const { id, usedGpu, hostPorts } = await up(client, recipe);
  console.log(dim(`  container ${id.slice(0, 12)}  gpu=${usedGpu ? "on" : "off"}`));

  const url = webUrl(recipe.manifest, { hostPorts });
  console.log(green("OK — up") + (url ? green(" at ") + cyan(url) : ""));
  return 0;
}
