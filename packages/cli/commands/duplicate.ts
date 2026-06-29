import { duplicateInstance } from "@compositz/core";
import { dim, green, red } from "@std/fmt/colors";
import { storeDir } from "../lib.ts";

/** Derive a fresh instance from an existing one (copies the bundle, not the data). */
export async function duplicateCmd(args: string[]): Promise<number> {
  if (!args[0]) {
    console.error(red("usage: compositz duplicate <instanceId>"));
    return 1;
  }
  const instance = await duplicateInstance(storeDir(), args[0]);
  console.log(green("OK — duplicated") + dim(` ${args[0]} → ${instance.instanceId}`));
  console.log(dim(`  run: compositz up ${instance.instanceId}`));
  return 0;
}
