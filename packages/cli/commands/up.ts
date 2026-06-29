import { EngineClient, installInstance, instanceImageTag, up, webUrl } from "@compositz/core";
import { bold, cyan, dim, green, red } from "@std/fmt/colors";
import { resolveInstance } from "../lib.ts";

/** Bring an instance up: build the image if missing, then create + start it. */
export async function upCmd(args: string[]): Promise<number> {
  if (!args[0]) {
    console.error(red("usage: compositz up <instanceId>"));
    return 1;
  }
  const instance = await resolveInstance(args[0]);
  const client = new EngineClient();
  const enc = new TextEncoder();

  if (!(await client.imageExists(instanceImageTag(instance.manifest, instance.instanceId)))) {
    console.log(dim("image not built yet — building…"));
    for await (const p of installInstance(client, instance)) {
      if (p.stream) await Deno.stdout.write(enc.encode(p.stream));
    }
  }

  console.log(bold(`starting ${instance.manifest.name}`) + dim(` (${instance.instanceId})`));
  const { id, usedGpu, hostPorts } = await up(client, instance);
  console.log(dim(`  container ${id.slice(0, 12)}  gpu=${usedGpu ? "on" : "off"}`));

  const url = webUrl(instance.manifest, { hostPorts });
  console.log(green("OK — up") + (url ? green(" at ") + cyan(url) : ""));
  return 0;
}
