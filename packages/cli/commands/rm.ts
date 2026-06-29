import { down, EngineClient, removeInstanceDir } from "@compositz/core";
import { dim, green, red } from "@std/fmt/colors";
import { storeDir } from "../lib.ts";

/**
 * Remove an instance: stop+remove its container, then delete its definition.
 * Persisted data (named volumes + data-root) is KEPT (safe default).
 */
export async function rm(args: string[]): Promise<number> {
  const instanceId = args[0];
  if (!instanceId) {
    console.error(red("usage: compositz rm <instanceId>"));
    return 1;
  }
  await down(new EngineClient(), instanceId);
  await removeInstanceDir(storeDir(), instanceId);
  console.log(green(`OK — removed instance ${instanceId}`) + dim(" (data volumes kept)"));
  return 0;
}
