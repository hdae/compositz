import {
  down,
  EngineClient,
  INSTANCE_ID_PATTERN,
  loadInstance,
  removeInstanceData,
  removeInstanceDir,
  removeInstanceImage,
} from "@compositz/core";
import { join } from "@std/path";
import { dim, green, red, yellow } from "@std/fmt/colors";
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
      // Ids flow into filesystem paths — a path-shaped "id" (`.`, `..`, `a/b`) must
      // never reach the recursive delete (removeInstanceDir guards too; this just
      // fails earlier with a per-id message).
      if (!INSTANCE_ID_PATTERN.test(id)) {
        throw new Error(`invalid instance id: "${id}"`);
      }
      // Load best-effort BEFORE removal to know the image tag + volume names; a
      // missing/corrupt instance still gets its dir removed (mirrors the UI delete).
      const instance = await loadInstance(join(store, id)).catch(() => undefined);
      await down(client, id);

      const notes: string[] = [];
      if (instance) {
        await removeInstanceImage(client, instance);
        notes.push("image removed");
      } else {
        // Without a readable definition neither the image tag nor the volume names
        // can be derived — say so instead of claiming a clean removal.
        notes.push("definition was unreadable — image and data volumes (if any) left as-is");
      }
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
        if (data.bindDirFailed) {
          // The volumes above are already gone — disclose the partial outcome
          // instead of failing as if nothing happened.
          failures++;
          console.error(yellow(
            `bind data NOT removed (${data.bindDirFailed.error}) — remove manually: ${data.bindDirFailed.path}`,
          ));
        }
      } else if (instance) {
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
