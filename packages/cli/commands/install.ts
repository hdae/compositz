import { EngineClient, installInstance, instanceImageTag } from "@compositz/core";
import { bold, dim, green, red } from "@std/fmt/colors";
import { resolveInstance } from "../lib.ts";

/** Build an instance's image from its Dockerfile + context. */
export async function install(args: string[]): Promise<number> {
  if (!args[0]) {
    console.error(red("usage: compositz install <instanceId>"));
    return 1;
  }
  const instance = await resolveInstance(args[0]);
  const client = new EngineClient();
  const enc = new TextEncoder();

  console.log(bold(`installing ${instance.manifest.name}`) + dim(` (${instance.instanceId})`));
  for await (const p of installInstance(client, instance)) {
    if (p.stream) await Deno.stdout.write(enc.encode(p.stream));
    if (p.aux?.ID) console.log(dim(`  image ${p.aux.ID.slice(0, 19)}…`));
  }
  console.log(green(`OK — built ${instanceImageTag(instance.manifest, instance.instanceId)}`));
  return 0;
}
