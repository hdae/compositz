import {
  down,
  EngineClient,
  loadInstance,
  removeInstanceDir,
  removeInstanceImage,
} from "@compositz/core";
import { join } from "@std/path";
import { dim, green, red } from "@std/fmt/colors";
import { storeDir } from "../lib.ts";

/**
 * Remove one or more instances: stop+remove each container, remove the per-instance
 * built image (no-op for `image`-based recipes — mirrors the UI delete), then delete
 * its definition. Persisted data (named volumes + data-root) is KEPT (safe default).
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
      // Load best-effort BEFORE removal to know the image tag; a missing/corrupt
      // instance still gets its dir removed (same contract as the UI delete route).
      const instance = await loadInstance(join(store, id)).catch(() => undefined);
      await down(client, id);
      if (instance) await removeInstanceImage(client, instance);
      await removeInstanceDir(store, id);
      console.log(green(`OK — removed ${id}`) + dim(" (image removed, data volumes kept)"));
    } catch (e) {
      failures++;
      console.error(red(`failed to remove ${id}: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
  return failures === 0 ? 0 : 1;
}
