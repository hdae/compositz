// High-level recipe operations shared by the CLI and the desktop app: install the
// image (build, or pull for an `image`-based recipe), bring a container up
// (honoring the GPU tri-state + host-port auto-increment), and tear it down.

import { containerName } from "../brand.ts";
import { tarContext } from "../build.ts";
import type { EngineClient } from "../engine/client.ts";
import type { BuildProgress } from "../engine/types.ts";
import { defaultDataRoot } from "../storage.ts";
import type { Recipe } from "./loader.ts";
import {
  type LaunchConfig,
  recipeContainerName,
  recipeImageTag,
  resolveHostPorts,
  toCreateSpec,
} from "./run.ts";

/**
 * Make the recipe's image available, streaming progress. A `build`-based recipe
 * builds from its context; an `image`-based recipe pulls the reference. Pull
 * layer-progress is coarse for now (a start/done line) — live layers land later.
 */
export async function* installRecipe(
  client: EngineClient,
  recipe: Recipe,
): AsyncGenerator<BuildProgress> {
  const m = recipe.manifest;
  if (m.image) {
    yield { stream: `pulling ${m.image}…\n` };
    await client.pull(m.image);
    yield { stream: `pulled ${m.image}\n` };
    return;
  }
  const tar = await tarContext(recipe.context);
  yield* client.build(tar, {
    tag: recipeImageTag(m),
    dockerfile: m.build!.dockerfile,
    buildArgs: m.build!.args,
  });
}

export interface UpResult {
  id: string;
  usedGpu: boolean;
  /** Host ports actually published, keyed by port name (after conflict bumping). */
  hostPorts: Record<string, number>;
}

/**
 * Create + start a container from the recipe, replacing any prior instance.
 * Host ports that collide with already-published ports are auto-bumped to a free
 * port. GPU tri-state: `required` insists on GPU, `none` never attaches it, and
 * `preferred` tries with GPU and transparently falls back to CPU on failure.
 */
export async function up(
  client: EngineClient,
  recipe: Recipe,
  launch: LaunchConfig = {},
): Promise<UpResult> {
  const m = recipe.manifest;
  const name = recipeContainerName(m);

  // Remove the prior instance first so its own host ports free up before we
  // pick ports for the new one.
  await client.remove(name, { force: true }).catch(() => {});

  // Resolve host ports ONCE (the GPU retry reuses them) and return them so callers
  // build the web URL from the port actually published, not the manifest default.
  const hostPorts = await resolvePorts(client, m, launch);
  const effective: LaunchConfig = { dataRoot: defaultDataRoot(), ...launch, hostPorts };

  const startWith = async (withGpu: boolean): Promise<string> => {
    const { Id } = await client.create(toCreateSpec(m, { ...effective, withGpu }), name);
    await client.start(Id);
    return Id;
  };

  if (m.gpu === "none") return { id: await startWith(false), usedGpu: false, hostPorts };
  if (m.gpu === "required") return { id: await startWith(true), usedGpu: true, hostPorts };

  // preferred: try GPU, fall back to CPU.
  try {
    return { id: await startWith(true), usedGpu: true, hostPorts };
  } catch {
    await client.remove(name, { force: true }).catch(() => {});
    return { id: await startWith(false), usedGpu: false, hostPorts };
  }
}

/**
 * Resolve each port's host port, auto-bumping any that collide with ports already
 * published by other running containers. Best-effort (it can't see non-Docker
 * listeners, and there is a small TOCTOU window before create).
 */
async function resolvePorts(
  client: EngineClient,
  m: Recipe["manifest"],
  launch: LaunchConfig,
): Promise<Record<string, number>> {
  if (m.ports.length === 0) return {};
  const desired = m.ports.map((p) => ({
    name: p.name,
    host: launch.hostPorts?.[p.name] ?? p.host ?? p.container,
  }));
  const taken = new Set<number>();
  try {
    for (const c of await client.ps()) {
      for (const port of c.Ports) if (port.PublicPort != null) taken.add(port.PublicPort);
    }
  } catch {
    // engine list failed — fall back to the desired ports unchanged.
  }
  return resolveHostPorts(desired, taken);
}

/** Stop and remove a recipe's container (no-op if absent). Persisted mounts survive. */
export async function down(
  client: EngineClient,
  recipeId: string,
  opts: { stopTimeout?: number } = {},
): Promise<void> {
  const name = containerName(recipeId);
  await client.stop(name, opts.stopTimeout).catch(() => {});
  await client.remove(name, { force: true }).catch(() => {});
}
