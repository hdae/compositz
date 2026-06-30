import { deconflictHostPorts, duplicateInstance } from "@compositz/core";
import { dim, green, red, yellow } from "@std/fmt/colors";
import { storeDir } from "../lib.ts";

/** Derive a fresh instance from an existing one (copies the bundle, not the data). */
export async function duplicateCmd(args: string[]): Promise<number> {
  if (!args[0]) {
    console.error(red("usage: compositz duplicate <instanceId>"));
    return 1;
  }
  const instance = await duplicateInstance(storeDir(), args[0]);
  // A duplicate shares the source recipe's ports, so it always collides — reassign + report.
  for (const b of await deconflictHostPorts(storeDir(), instance)) {
    console.log(yellow(`  note: ${b.name} port ${b.from} in use → reassigned to ${b.to}`));
  }
  console.log(green("OK — duplicated") + dim(` ${args[0]} → ${instance.instanceId}`));
  console.log(dim(`  run: compositz up ${instance.instanceId}`));
  return 0;
}
