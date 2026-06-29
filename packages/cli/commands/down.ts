import { down, EngineClient } from "@compositz/core";
import { green, red } from "@std/fmt/colors";

/** Stop and remove an instance's container (by instance id). */
export async function downCmd(args: string[]): Promise<number> {
  const instanceId = args[0];
  if (!instanceId) {
    console.error(red("usage: compositz down <instanceId>"));
    return 1;
  }
  await down(new EngineClient(), instanceId);
  console.log(green(`OK — ${instanceId} stopped & removed`));
  return 0;
}
