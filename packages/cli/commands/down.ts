import { down, EngineClient } from "@compositz/core";
import { green, red } from "@std/fmt/colors";
import { resolveRecipe } from "../lib.ts";

/** Stop and remove a recipe's container. Accepts a recipe id or directory. */
export async function downCmd(args: string[]): Promise<number> {
  if (!args[0]) {
    console.error(red("usage: compositz down <recipe>"));
    return 1;
  }
  // Prefer the manifest id; fall back to treating the arg as an id directly.
  let id = args[0];
  try {
    id = (await resolveRecipe(args[0])).id;
  } catch {
    // arg is already an id
  }
  await down(new EngineClient(), id);
  console.log(green(`OK — ${id} stopped & removed`));
  return 0;
}
