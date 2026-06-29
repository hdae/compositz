import { down, EngineClient, removeInstanceDir } from "@compositz/core";
import { dim, green, red } from "@std/fmt/colors";
import { storeDir } from "../lib.ts";

/**
 * Remove one or more instances: stop+remove each container, then delete its
 * definition. Persisted data (named volumes + data-root) is KEPT (safe default).
 * Continues past a failing id and exits non-zero if any failed.
 */
export async function rm(args: string[]): Promise<number> {
  if (args.length === 0) {
    console.error(red("usage: compositz rm <instanceId>..."));
    return 1;
  }
  const client = new EngineClient();
  const store = storeDir();
  let failures = 0;
  for (const id of args) {
    try {
      await down(client, id);
      await removeInstanceDir(store, id);
      console.log(green(`OK — removed ${id}`) + dim(" (data volumes kept)"));
    } catch (e) {
      failures++;
      console.error(red(`failed to remove ${id}: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
  return failures === 0 ? 0 : 1;
}
