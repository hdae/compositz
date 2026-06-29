// High-level instance operations shared by the CLI and the UI: install the image
// (build per-instance, or pull for an `image`-based recipe), bring the container
// up (GPU tri-state + host-port auto-increment), and tear it down. Everything keys
// off the instance id (ADR-017).

import { containerName } from "../brand.ts";
import { tarContext } from "../build.ts";
import type { EngineClient } from "../engine/client.ts";
import type { BuildProgress } from "../engine/types.ts";
import { defaultDataRoot } from "../storage.ts";
import type { Instance } from "./instance.ts";
import {
  instanceContainerName,
  instanceImageTag,
  type LaunchConfig,
  resolveHostPorts,
  toCreateSpec,
} from "./run.ts";

/**
 * Make the instance's image available, streaming progress. A `build`-based recipe
 * builds its context to the per-instance tag `compositz/<instanceId>`; an
 * `image`-based recipe pulls the referenced (shared) image. Pull layer-progress is
 * coarse for now (a start/done line) — live layers land later.
 */
export async function* installInstance(
  client: EngineClient,
  instance: Instance,
): AsyncGenerator<BuildProgress> {
  const m = instance.manifest;
  if (m.image) {
    yield { stream: `pulling ${m.image}…\n` };
    await client.pull(m.image);
    yield { stream: `pulled ${m.image}\n` };
    return;
  }
  const tar = await tarContext(instance.context);
  yield* client.build(tar, {
    tag: instanceImageTag(m, instance.instanceId),
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
 * Create + start the instance's container, replacing any prior container for this
 * instance. Host ports that collide with already-published ports are auto-bumped to
 * a free port. GPU tri-state: `required` insists on GPU, `none` never attaches it,
 * and `preferred` tries with GPU and transparently falls back to CPU on failure.
 */
export async function up(
  client: EngineClient,
  instance: Instance,
  launch: LaunchConfig = {},
): Promise<UpResult> {
  const m = instance.manifest;
  const name = instanceContainerName(instance.instanceId);

  // Remove the prior container first so its own host ports free up before we
  // pick ports for the new one.
  await client.remove(name, { force: true }).catch(() => {});

  // Resolve host ports ONCE (the GPU retry reuses them) and return them so callers
  // build the web URL from the port actually published, not the manifest default.
  const hostPorts = await resolvePorts(client, m, launch);
  const effective: LaunchConfig = { dataRoot: defaultDataRoot(), ...launch, hostPorts };

  const startWith = async (withGpu: boolean): Promise<string> => {
    const spec = toCreateSpec(m, instance.instanceId, { ...effective, withGpu });
    const { Id } = await client.create(spec, name);
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
  m: Instance["manifest"],
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

/** Stop and remove an instance's container (no-op if absent). Persisted mounts survive. */
export async function down(
  client: EngineClient,
  instanceId: string,
  opts: { stopTimeout?: number } = {},
): Promise<void> {
  const name = containerName(instanceId);
  await client.stop(name, opts.stopTimeout).catch(() => {});
  await client.remove(name, { force: true }).catch(() => {});
}
