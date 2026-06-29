import { listInstances } from "@compositz/core";
import { cyan, dim, green } from "@std/fmt/colors";
import { storeDir } from "../lib.ts";

/** List instances in the store. */
export async function ls(_args: string[]): Promise<number> {
  const list = await listInstances(storeDir());
  if (list.length === 0) {
    console.log(dim("no instances — import one: compositz import <archive|dir>"));
    return 0;
  }
  console.log(dim("INSTANCE".padEnd(28) + "APP".padEnd(14) + "VERSION".padEnd(10) + "NAME"));
  for (const i of list) {
    console.log(
      `${green(i.instanceId.padEnd(28))}${i.appId.padEnd(14)}${i.manifest.version.padEnd(10)}${
        cyan(i.manifest.name)
      }`,
    );
  }
  return 0;
}
