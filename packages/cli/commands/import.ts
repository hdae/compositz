import { ingestBundle, ingestGithub } from "@compositz/core";
import { dim, green, red } from "@std/fmt/colors";
import { storeDir } from "../lib.ts";

const USAGE =
  "usage: compositz import <archive.tar|archive.tar.gz|dir|github:owner/repo[/subdir][@ref]>";

/** Import a recipe → create an instance: a tar/tar.gz archive, a directory, or GitHub. */
export async function importCmd(args: string[]): Promise<number> {
  const arg = args[0];
  if (!arg) {
    console.error(red(USAGE));
    return 1;
  }

  let instance;
  if (arg.startsWith("github:")) {
    // A GitHub source: parse → download the codeload tarball → ingest (errors from
    // here propagate to main.ts and are printed in red).
    instance = await ingestGithub(arg, storeDir());
  } else {
    let stat: Deno.FileInfo;
    try {
      stat = await Deno.stat(arg);
    } catch {
      console.error(red(`not found: ${arg}`));
      return 1;
    }
    if (stat.isDirectory) {
      instance = await ingestBundle({ kind: "dir", dir: arg }, storeDir(), {
        source: `dir:${arg}`,
      });
    } else {
      // Stream the file through extraction (never buffer it whole in RAM).
      const file = await Deno.open(arg, { read: true });
      instance = await ingestBundle(
        { kind: "archive", stream: file.readable },
        storeDir(),
        { source: `file:${arg}` },
      );
    }
  }

  console.log(green(`OK — imported ${instance.manifest.name}`) + dim(` as ${instance.instanceId}`));
  console.log(dim(`  run: compositz up ${instance.instanceId}`));
  return 0;
}
