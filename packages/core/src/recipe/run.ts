// Derive a Docker container spec (the "effective spec") from a validated manifest
// plus an optional per-install launch override: manifest ⊕ launch → ContainerCreateSpec.
// Also the small derived values callers need (image tag, container name, web URLs).

import {
  cacheVolumeName,
  containerName,
  envVar,
  imageTag,
  label,
  MANAGED_MOUNT_ROOT,
  volumeName,
} from "../brand.ts";
import { CompositzError } from "../errors.ts";
import { GPU_ALL_NVIDIA } from "../engine/types.ts";
import type { ContainerCreateSpec, HostConfig, Mount, PortBinding } from "../engine/types.ts";
import { bindHostPath } from "../storage.ts";
import type { CacheSpec, Manifest } from "./manifest.ts";

/** Default instance name. Multi-instance is deferred but the schema/labels are ready. */
export const DEFAULT_INSTANCE = "default";

/**
 * The user's per-install customizations, layered over the manifest's author
 * defaults. Carries only VALUES — the manifest is never mutated. Persisted form
 * lands with the override UI (RI-4); here it is an in-memory overlay.
 */
export type LaunchConfig = {
  /** Instance name (default "default"). */
  instance?: string;
  /** Host data-root for bind mounts (required only when a bind mount is effective). */
  dataRoot?: string;
  /** Host-port remap, keyed by port `name`. */
  hostPorts?: Record<string, number>;
  /** Resolved env values, keyed by env `name` (overrides the manifest default). */
  env?: Record<string, string>;
  /** Placement override, keyed by mount `name`. */
  placement?: Record<string, "bind" | "volume">;
};

export type ToSpecOptions = LaunchConfig & {
  /** Override GPU attachment; defaults to (manifest.gpu !== "none"). */
  withGpu?: boolean;
};

/** The image this recipe runs: a prebuilt `image`, or the tag we build it to. */
export function recipeImageTag(m: Manifest): string {
  return m.image ?? imageTag(m.id, m.version);
}

export function recipeContainerName(m: Manifest): string {
  return containerName(m.id);
}

/** Effective host port for a named port: launch remap ▷ manifest host ▷ container. */
function hostPortOf(p: Manifest["ports"][number], launch: LaunchConfig): number {
  return launch.hostPorts?.[p.name] ?? p.host ?? p.container;
}

export type WebEndpoint = { name: string; url: string };

/** Every browser-UI endpoint (one per `web: true` port), in declaration order. */
export function webEndpoints(m: Manifest, launch: LaunchConfig = {}): WebEndpoint[] {
  return m.ports
    .filter((p) => p.web)
    .map((p) => ({ name: p.name, url: `http://localhost:${hostPortOf(p, launch)}${p.path}` }));
}

/** The primary (first) web UI URL, if the recipe publishes one. */
export function webUrl(m: Manifest, launch: LaunchConfig = {}): string | undefined {
  return webEndpoints(m, launch)[0]?.url;
}

/**
 * Shift any host ports that collide with `taken` up to the next free port, keeping
 * the rest as-is. Pure — the caller supplies the taken set (e.g. ports already
 * published by other containers). Returns a name→port map for `LaunchConfig.hostPorts`.
 */
export function resolveHostPorts(
  ports: ReadonlyArray<{ name: string; host: number }>,
  taken: ReadonlySet<number>,
): Record<string, number> {
  const used = new Set(taken);
  const out: Record<string, number> = {};
  for (const p of ports) {
    let host = p.host;
    while (used.has(host)) {
      host++;
      if (host > 65535) {
        throw new CompositzError(`no free host port for "${p.name}" at or above ${p.host}`);
      }
    }
    out[p.name] = host;
    used.add(host);
  }
  return out;
}

export function toCreateSpec(m: Manifest, opts: ToSpecOptions = {}): ContainerCreateSpec {
  const instance = opts.instance ?? DEFAULT_INSTANCE;

  // --- ports ---------------------------------------------------------------
  // Keyed by container/proto; APPEND host bindings so two ports on the same
  // container port publish to both host ports instead of one silently winning.
  const exposed: Record<string, Record<string, never>> = {};
  const bindings: Record<string, PortBinding[]> = {};
  for (const p of m.ports) {
    const key = `${p.container}/${p.protocol}`;
    exposed[key] = {};
    (bindings[key] ??= []).push({ HostPort: String(hostPortOf(p, opts)) });
  }

  // --- mounts (persisted) + caches → HostConfig.Mounts ---------------------
  const mounts: Mount[] = [];
  for (const mt of m.mounts) {
    const placement = opts.placement?.[mt.name] ?? mt.placement;
    if (placement === "bind") {
      if (!opts.dataRoot) {
        throw new CompositzError(
          `mount "${mt.name}" of recipe "${m.id}" is a bind mount but no dataRoot was supplied`,
        );
      }
      // CreateMountpoint: the daemon must create the host source if absent — a
      // `Mounts` bind does not auto-create it (unlike legacy `Binds`).
      mounts.push({
        Type: "bind",
        Source: bindHostPath(opts.dataRoot, m.id, mt.name),
        Target: mt.target,
        BindOptions: { CreateMountpoint: true },
      });
    } else {
      mounts.push({ Type: "volume", Source: volumeName(m.id, mt.name), Target: mt.target });
    }
  }

  // --- env: keyed so managed cache/instance vars deterministically override a
  // colliding user var (a list with duplicate keys has undefined precedence). --
  const envMap = new Map<string, string>();
  for (const ev of m.env) envMap.set(ev.name, opts.env?.[ev.name] ?? ev.default ?? "");
  for (const c of m.cache) {
    const { mount, vars } = cacheProvision(c, m.id, instance);
    // Shared cache volumes (venv/hf) mount once even if referenced repeatedly.
    if (!mounts.some((x) => x.Source === mount.Source && x.Target === mount.Target)) {
      mounts.push(mount);
    }
    for (const [k, v] of vars) envMap.set(k, v);
  }
  envMap.set(envVar("INSTANCE"), instance);
  const env = [...envMap].map(([k, v]) => `${k}=${v}`);

  // Two mounts (or a mount and a managed cache) on one in-container target is a
  // daemon-invalid spec — fail loud rather than let one silently shadow the other.
  const targets = new Set<string>();
  for (const mt of mounts) {
    if (targets.has(mt.Target)) {
      throw new CompositzError(
        `recipe "${m.id}": duplicate mount target "${mt.Target}" (a mount collides with another mount or a managed cache)`,
      );
    }
    targets.add(mt.Target);
  }

  // --- host config ---------------------------------------------------------
  const hostConfig: HostConfig = {};
  if (Object.keys(bindings).length > 0) hostConfig.PortBindings = bindings;
  if (mounts.length > 0) hostConfig.Mounts = mounts;
  if (opts.withGpu ?? (m.gpu !== "none")) hostConfig.DeviceRequests = [GPU_ALL_NVIDIA];

  return {
    Image: recipeImageTag(m),
    Env: env.length > 0 ? env : undefined,
    ExposedPorts: Object.keys(exposed).length > 0 ? exposed : undefined,
    Tty: false,
    Labels: {
      [label("recipe")]: m.id,
      [label("managed")]: "true",
      [label("version")]: m.version,
      [label("instance")]: instance,
    },
    HostConfig: hostConfig,
  };
}

/** A managed cache: one mount plus the env var(s) carrying its in-container path. */
type CacheMount = { mount: Mount; vars: Array<[string, string]> };

function cacheProvision(c: CacheSpec, recipeId: string, instance: string): CacheMount {
  switch (c.type) {
    case "venv": {
      // venv + uv cache co-located on ONE volume so uv's hardlink dedup works
      // (ADR-006). Shared across apps; per-(app,instance) venv subpath.
      const target = `${MANAGED_MOUNT_ROOT}/uv`;
      return {
        mount: { Type: "volume", Source: cacheVolumeName("uv"), Target: target },
        vars: [
          ["UV_CACHE_DIR", `${target}/cache`],
          ["VIRTUAL_ENV", `${target}/venvs/${recipeId}/${instance}`],
        ],
      };
    }
    case "huggingface": {
      const target = `${MANAGED_MOUNT_ROOT}/hf`;
      return {
        mount: { Type: "volume", Source: cacheVolumeName("hf"), Target: target },
        vars: [["HF_HOME", target]],
      };
    }
    case "custom": {
      const target = `${MANAGED_MOUNT_ROOT}/cache/${c.name}`;
      const path = c.scope === "instance" ? `${target}/${recipeId}/${instance}` : target;
      return {
        mount: { Type: "volume", Source: cacheVolumeName(`cache_${c.name}`), Target: target },
        vars: [[c.env, path]],
      };
    }
  }
}
