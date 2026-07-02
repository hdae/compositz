// High-level instance operations shared by the CLI and the UI: install the image
// (build per-instance, or pull for an `image`-based recipe), bring the container
// up (GPU tri-state + host-port auto-increment), and tear it down. Everything keys
// off the instance id (ADR-017).

import { join } from "@std/path";
import { containerName, imageTag, label, volumeName } from "../brand.ts";
import { tarContext } from "../build.ts";
import { CompositzError } from "../errors.ts";
import type { EngineClient } from "../engine/client.ts";
import type { BuildProgress } from "../engine/types.ts";
import { defaultDataRoot } from "../storage.ts";
import {
  type Instance,
  listInstances,
  loadInstanceConfig,
  saveInstanceConfig,
  saveLaunchedConfig,
} from "./instance.ts";
import {
  effectiveHostPort,
  instanceContainerName,
  instanceImageTag,
  type LaunchConfig,
  mergeLaunch,
  persistedMounts,
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

  // The persisted per-instance override (config.yaml) is the base; the in-memory
  // `launch` arg overlays it so a caller can still force values. Loading it here means
  // every caller (CLI / UI) honors the saved override without wiring it themselves.
  const override = await loadInstanceConfig(instance.dir);
  const merged = mergeLaunch(override, launch);

  // Resolve host ports ONCE (the GPU retry reuses them) and return them so callers
  // build the web URL from the port actually published, not the manifest default.
  const hostPorts = await resolvePorts(client, m, merged);
  const effective: LaunchConfig = { dataRoot: defaultDataRoot(), ...merged, hostPorts };

  const startWith = async (withGpu: boolean): Promise<string> => {
    const spec = toCreateSpec(m, instance.instanceId, { ...effective, withGpu });
    const { Id } = await client.create(spec, name);
    await client.start(Id);
    return Id;
  };

  const run = async (): Promise<UpResult> => {
    if (m.gpu === "none") return { id: await startWith(false), usedGpu: false, hostPorts };
    if (m.gpu === "required") return { id: await startWith(true), usedGpu: true, hostPorts };
    // preferred: try GPU, fall back to CPU.
    try {
      return { id: await startWith(true), usedGpu: true, hostPorts };
    } catch {
      await client.remove(name, { force: true }).catch(() => {});
      return { id: await startWith(false), usedGpu: false, hostPorts };
    }
  };

  const result = await run();
  // Record what we just launched WITH (the user-level override) so the UI can tell when
  // the saved config has since diverged and a restart is needed. Best-effort.
  await saveLaunchedConfig(instance.dir, override).catch(() => {});
  return result;
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

/** A host port reassigned away from a collision: `name`'s desired `from` → assigned `to`. */
export type PortBump = { name: string; from: number; to: number };

/**
 * Every host port DEFINED (manifest ⊕ persisted override) by instances in the store,
 * optionally excluding one instance. Engine-independent (no `ps`) — so it reflects
 * stopped instances too. The source of truth for "which host ports are spoken for"
 * shared by add-time deconfliction and the Settings conflict warning.
 */
export async function definedHostPorts(
  instancesDir: string,
  excludeInstanceId?: string,
): Promise<number[]> {
  const ports: number[] = [];
  for (const inst of await listInstances(instancesDir)) {
    if (inst.instanceId === excludeInstanceId) continue;
    const ovr = await loadInstanceConfig(inst.dir);
    for (const p of inst.manifest.ports) ports.push(effectiveHostPort(p, ovr.hostPorts));
  }
  return ports;
}

/**
 * Deconflict a freshly-created instance's host ports against the DEFINED host ports of
 * all OTHER instances in the store (manifest ⊕ persisted override — engine-independent,
 * so it catches stopped instances too). Each colliding port is reassigned to the next
 * free one, PERSISTED to this instance's `config.yaml` override (so the assignment is
 * stable and visible in the Settings editor), and reported. Returns the bumps (empty if
 * none) so the caller can NOTIFY the user — reducing the surprise of a silent remap.
 *
 * This is the add-time counterpart to `up`'s launch-time `resolvePorts`: add-time keeps
 * managed instances from colliding by definition; `up` stays the safety net for ports
 * held by non-managed (external) processes at launch.
 */
export async function deconflictHostPorts(
  instancesDir: string,
  instance: Instance,
): Promise<PortBump[]> {
  const taken = new Set(await definedHostPorts(instancesDir, instance.instanceId));

  const override = await loadInstanceConfig(instance.dir);
  const desired = instance.manifest.ports.map((p) => ({
    name: p.name,
    host: effectiveHostPort(p, override.hostPorts),
  }));
  const resolved = resolveHostPorts(desired, taken);
  const bumps = desired
    .filter((d) => resolved[d.name] !== d.host)
    .map((d) => ({ name: d.name, from: d.host, to: resolved[d.name] }));

  if (bumps.length > 0) {
    const hostPorts = { ...override.hostPorts };
    for (const b of bumps) hostPorts[b.name] = b.to;
    await saveInstanceConfig(instance.dir, { ...override, hostPorts });
  }
  return bumps;
}

/** In-container path the export helper mounts the target data under. */
const EXPORT_MOUNT_ROOT = "/compositz-export";

/**
 * Export one persisted mount's data as a tar stream (root dir = the mount name).
 * Works whether or not the instance is running: a throwaway helper container is
 * CREATED (never started) with only that mount attached read-only, the data is read
 * via the archive API, and the helper is removed once the stream ends (or errors, or
 * is cancelled). Requires the instance image locally — the helper reuses it so
 * nothing external is pulled. Concurrent-safe with a running instance (a tar taken
 * mid-write may catch a file in transit; re-export for a quiescent snapshot).
 */
export async function exportMount(
  client: EngineClient,
  instance: Instance,
  mountName: string,
): Promise<ReadableStream<Uint8Array>> {
  const m = instance.manifest;
  const mountIndex = m.mounts.findIndex((mt) => mt.name === mountName);
  if (mountIndex < 0) {
    const names = m.mounts.map((mt) => mt.name).join(", ") || "(none)";
    throw new CompositzError(`no mount "${mountName}" in "${m.id}" — available: ${names}`);
  }

  // Same derivation as `up` (persistedMounts): the effective placement (override ▷
  // manifest) decides WHICH data the app actually uses, so that is what exports.
  const override = await loadInstanceConfig(instance.dir);
  const source = persistedMounts(m, instance.instanceId, {
    dataRoot: defaultDataRoot(),
    placement: override.placement,
  })[mountIndex];

  // Fail loud on absent data rather than exporting a silently-empty tar: a missing
  // volume would be auto-created empty at helper create (Docker semantics), so check
  // it first (the name filter is a substring match — compare exactly). A missing
  // bind source is rejected by the daemon at create (no CreateMountpoint here).
  if (source.Type === "volume") {
    const vols = await client.listVolumes({ filters: { name: [source.Source] } });
    if (!vols.some((v) => v.Name === source.Source)) {
      throw new CompositzError(
        `mount "${mountName}" has no volume "${source.Source}" yet — nothing to export (never started?)`,
      );
    }
  }

  const image = instanceImageTag(m, instance.instanceId);
  if (!(await client.imageExists(image))) {
    throw new CompositzError(
      `image ${image} is not available locally — install the instance first (the export helper reuses it)`,
    );
  }

  const exportPath = `${EXPORT_MOUNT_ROOT}/${mountName}`;
  const helperName = `${containerName(instance.instanceId)}-export-${
    crypto.randomUUID().slice(0, 8)
  }`;
  const { Id } = await client.create({
    Image: image,
    // Never started — the Cmd only satisfies image configs without a default command.
    Cmd: ["compositz-export-noop"],
    Labels: {
      [label("managed")]: "true",
      [label("instance")]: instance.instanceId,
      [label("role")]: "export-helper",
    },
    HostConfig: {
      Mounts: [{ Type: source.Type, Source: source.Source, Target: exportPath, ReadOnly: true }],
    },
  }, helperName);
  const cleanup = () => client.remove(Id, { force: true }).catch(() => {});

  let inner: ReadableStream<Uint8Array>;
  try {
    inner = await client.archive(Id, exportPath);
  } catch (e) {
    await cleanup();
    throw e;
  }

  // Hand the consumer a stream that tears the helper down however consumption ends.
  // Cleanup MUST complete BEFORE the stream reports closed: a consumer awaiting
  // `pipeTo` resolves on close, and a CLI process exits right after — closing first
  // would race the helper's DELETE against process exit and leak the container.
  const reader = inner.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          await cleanup();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (e) {
        await cleanup();
        controller.error(e);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
      await cleanup();
    },
  });
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

export interface RemoveDataResult {
  /** Per-instance named volumes that existed and were removed. */
  volumesRemoved: string[];
  /** Volumes that could not be removed (e.g. still mounted — 409). Never forced. */
  volumesFailed: Array<{ name: string; error: string }>;
  /** The data-root bind dir removed (set only when `bindData` was requested and it existed). */
  bindDirRemoved?: string;
}

/**
 * Remove an instance's PERSISTED DATA — irreversible. Per-instance named volumes are
 * removed for EVERY manifest mount regardless of its current placement (a placement
 * flip may have left data in both forms); names derive from the definition
 * (`volumeName(id, mount)`), so the shared cache volumes (`compositz_uv` / `_hf` /
 * `_cache_*`) are structurally out of reach. With `bindData: true`, the instance's
 * host-browsable data-root dir (`<data-root>/<instanceId>`) is removed too — kept by
 * default (persist-worthy data lives there by convention). Call `down` first: a
 * volume still mounted by a container fails (409) and is REPORTED, never forced.
 * NOTE: the bind dir is removed with local fs APIs — correct for a local daemon (the
 * standard setup); over a remote DOCKER_HOST the files live on that host and stay.
 */
export async function removeInstanceData(
  client: EngineClient,
  instance: Instance,
  opts: { volumes?: boolean; bindData?: boolean; dataRoot?: string } = {},
): Promise<RemoveDataResult> {
  const result: RemoveDataResult = { volumesRemoved: [], volumesFailed: [] };

  if (opts.volumes ?? true) {
    for (const mt of instance.manifest.mounts) {
      const name = volumeName(instance.instanceId, mt.name);
      // Docker's name filter is a substring match — confirm exactly before counting
      // a removal (a 404-tolerant delete alone couldn't tell "removed" from "absent").
      const exists = (await client.listVolumes({ filters: { name: [name] } }))
        .some((v) => v.Name === name);
      if (!exists) continue;
      try {
        await client.removeVolume(name);
        result.volumesRemoved.push(name);
      } catch (e) {
        result.volumesFailed.push({ name, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  if (opts.bindData) {
    const dir = join(opts.dataRoot ?? defaultDataRoot(), instance.instanceId);
    try {
      await Deno.remove(dir, { recursive: true });
      result.bindDirRemoved = dir;
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }

  return result;
}

/**
 * Remove the per-instance built image (`compositz/<instanceId>:<version>`) on delete.
 * No-op for an `image`-based recipe — its image is shared/external and MUST never be
 * removed. Best-effort: a missing image (already gone) is fine, and an unforced delete
 * leaves the image intact if a container still references it (call `down` first).
 * Keeps deletion managed-only and reversible-by-reimport (the Docker-safety constraint).
 */
export async function removeInstanceImage(
  client: EngineClient,
  instance: Instance,
): Promise<void> {
  if (instance.manifest.image) return; // shared external image — never remove
  // MUST use the brand `imageTag` (the per-instance build tag `compositz/<id>:<ver>`),
  // NOT `instanceImageTag` — the latter returns `m.image` for an image-based recipe,
  // i.e. the shared external tag we just guarded against. The guard above and this tag
  // are two halves of one invariant; keep them together.
  const tag = imageTag(instance.instanceId, instance.manifest.version);
  await client.removeImage(tag).catch(() => {});
}
