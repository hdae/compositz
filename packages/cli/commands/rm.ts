import {
  down,
  EngineClient,
  loadInstance,
  removeInstanceData,
  removeInstanceDir,
  removeInstanceImage,
} from "@compositz/core";
import { join } from "@std/path";
import { dim, green, red } from "@std/fmt/colors";
import { storeDir } from "../lib.ts";

/**
 * Remove one or more instances: stop+remove the container, the per-instance built
 * image, the DATA VOLUMES (default — persist-worthy data belongs in a `bind` mount),
 * then the definition. `--keep-data` keeps the volumes (the old safe behavior);
 * `--purge` also removes the host-browsable data-root dir. When a volume can't be
 * removed (still mounted), the DEFINITION IS KEPT so a retry can still derive the
 * volume names. Continues past a failing id and exits non-zero if any failed.
 */
export async function rm(args: string[]): Promise<number> {
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const ids = args.filter((a) => !a.startsWith("--"));
  const unknown = [...flags].filter((f) => f !== "--keep-data" && f !== "--purge");
  if (
    unknown.length > 0 || ids.length === 0 || (flags.has("--keep-data") && flags.has("--purge"))
  ) {
    console.error(red("usage: compositz rm [--keep-data | --purge] <instanceId>..."));
    return 1;
  }
  const keepData = flags.has("--keep-data");
  const purge = flags.has("--purge");

  const client = new EngineClient();
  const store = storeDir();
  let failures = 0;
  for (const id of ids) {
    try {
      // Load best-effort BEFORE removal to know the image tag + volume names; a
      // missing/corrupt instance still gets its dir removed (mirrors the UI delete).
      const instance = await loadInstance(join(store, id)).catch(() => undefined);
      await down(client, id);
      if (instance) await removeInstanceImage(client, instance);

      const notes = ["image removed"];
      if (instance && !keepData) {
        const data = await removeInstanceData(client, instance, { bindData: purge });
        if (data.volumesFailed.length > 0) {
          failures++;
          for (const f of data.volumesFailed) {
            console.error(red(`failed to remove volume ${f.name}: ${f.error}`));
          }
          console.error(red(`kept ${id}'s definition — retry \`compositz rm ${id}\``));
          continue; // keep the definition: without it the volume names can't be re-derived
        }
        if (data.volumesRemoved.length > 0) {
          notes.push(`${data.volumesRemoved.length} data volume(s) removed`);
        }
        if (data.bindDirRemoved) notes.push("bind data removed");
      } else {
        notes.push("data volumes kept");
      }

      await removeInstanceDir(store, id);
      console.log(green(`OK — removed ${id}`) + dim(` (${notes.join(", ")})`));
    } catch (e) {
      failures++;
      console.error(red(`failed to remove ${id}: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
  return failures === 0 ? 0 : 1;
}
