import { type Instance, instancesDir, loadInstance } from "@compositz/core";
import { join } from "@std/path";

/** The instance store this CLI reads/writes (app-data; COMPOSITZ_INSTANCES_DIR overrides). */
export function storeDir(): string {
  return instancesDir();
}

/** Resolve an instance by its id, from the instance store. */
export async function resolveInstance(instanceId: string): Promise<Instance> {
  try {
    return await loadInstance(join(storeDir(), instanceId));
  } catch {
    throw new Error(
      `instance not found: "${instanceId}" (in ${storeDir()}). Run \`compositz ls\`.`,
    );
  }
}
