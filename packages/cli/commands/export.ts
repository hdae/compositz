import { EngineClient, exportMount } from "@compositz/core";
import { dim, green, red } from "@std/fmt/colors";
import { resolveInstance } from "../lib.ts";

/**
 * Export one persisted mount's data as a tar file (root dir = the mount name).
 * With no mount name, list the instance's exportable mounts. Works on a stopped
 * instance — the data is read through a throwaway helper container (never started).
 */
export async function exportCmd(args: string[]): Promise<number> {
  const [id, mount, out] = args;
  if (!id) {
    console.error(red("usage: compositz export <instanceId> [mount] [outFile]"));
    return 1;
  }
  const instance = await resolveInstance(id);

  if (!mount) {
    const mounts = instance.manifest.mounts;
    if (mounts.length === 0) {
      console.log(`no persisted mounts in "${instance.appId}" — nothing to export`);
      return 0;
    }
    console.log("exportable mounts:");
    for (const mt of mounts) console.log(`  ${mt.name.padEnd(14)} ${dim(mt.target)}`);
    console.log(dim(`\nrun: compositz export ${id} <mount> [outFile]`));
    return 0;
  }

  const client = new EngineClient();
  const outFile = out ?? `${id}-${mount}.tar`;
  const stream = await exportMount(client, instance, mount);
  const file = await Deno.open(outFile, { write: true, create: true, truncate: true });
  await stream.pipeTo(file.writable); // closes the file when the stream ends
  const { size } = await Deno.stat(outFile);
  console.log(green(`OK — exported ${mount} → ${outFile}`) + dim(` (${formatSize(size)})`));
  return 0;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}
