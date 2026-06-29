import { ingestBundle } from "@compositz/core";
import { dim, green, red } from "@std/fmt/colors";
import { storeDir } from "../lib.ts";

/** Import a recipe bundle (tar/tar.gz archive or a directory) → create an instance. */
export async function importCmd(args: string[]): Promise<number> {
  const path = args[0];
  if (!path) {
    console.error(red("usage: compositz import <archive.tar|archive.tar.gz|dir>"));
    return 1;
  }
  let stat: Deno.FileInfo;
  try {
    stat = await Deno.stat(path);
  } catch {
    console.error(red(`not found: ${path}`));
    return 1;
  }

  let instance;
  if (stat.isDirectory) {
    instance = await ingestBundle({ kind: "dir", dir: path }, storeDir(), {
      source: `dir:${path}`,
    });
  } else {
    // Stream the file through extraction (never buffer it whole in RAM).
    const file = await Deno.open(path, { read: true });
    instance = await ingestBundle(
      { kind: "archive", stream: file.readable },
      storeDir(),
      { source: `file:${path}` },
    );
  }

  console.log(green(`OK — imported ${instance.manifest.name}`) + dim(` as ${instance.instanceId}`));
  console.log(dim(`  run: compositz up ${instance.instanceId}`));
  return 0;
}
