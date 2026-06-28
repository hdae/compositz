// Translate a validated manifest into a Docker container spec, plus the small
// derived values (image tag, container name, web URL) callers need.

import { containerName, imageTag, label, volumeName } from "../brand.ts";
import { GPU_ALL_NVIDIA } from "../engine/types.ts";
import type { ContainerCreateSpec, HostConfig, PortBinding } from "../engine/types.ts";
import type { Manifest } from "./manifest.ts";

export function recipeImageTag(m: Manifest): string {
  return imageTag(m.id, m.version);
}

export function recipeContainerName(m: Manifest): string {
  return containerName(m.id);
}

/** Host port the web UI is published on, if the recipe declares one. */
export function webHostPort(m: Manifest): number | undefined {
  return m.web ? (m.web.hostPort ?? m.web.port) : undefined;
}

/** The local URL of the recipe's web UI, if any. */
export function webUrl(m: Manifest): string | undefined {
  const port = webHostPort(m);
  return port === undefined ? undefined : `http://localhost:${port}${m.web!.path}`;
}

export interface ToSpecOptions {
  /** Override GPU attachment; defaults to (manifest.gpu !== "none"). */
  withGpu?: boolean;
}

export function toCreateSpec(m: Manifest, opts: ToSpecOptions = {}): ContainerCreateSpec {
  const exposed: Record<string, Record<string, never>> = {};
  const bindings: Record<string, PortBinding[]> = {};
  const publish = (container: number, host: number | undefined, proto: "tcp" | "udp") => {
    const key = `${container}/${proto}`;
    exposed[key] = {};
    bindings[key] = [{ HostPort: String(host ?? container) }];
  };
  for (const p of m.ports) publish(p.container, p.host, p.protocol);
  if (m.web) publish(m.web.port, m.web.hostPort, "tcp");

  const hostConfig: HostConfig = {};
  if (Object.keys(bindings).length > 0) hostConfig.PortBindings = bindings;
  if (m.volumes.length > 0) {
    hostConfig.Binds = m.volumes.map((v) => `${volumeName(m.id, v.name)}:${v.target}`);
  }
  if (opts.withGpu ?? (m.gpu !== "none")) {
    hostConfig.DeviceRequests = [GPU_ALL_NVIDIA];
  }

  return {
    Image: recipeImageTag(m),
    Env: m.env.length > 0 ? m.env : undefined,
    ExposedPorts: Object.keys(exposed).length > 0 ? exposed : undefined,
    Tty: false,
    Labels: {
      [label("recipe")]: m.id,
      [label("managed")]: "true",
      [label("version")]: m.version,
    },
    HostConfig: hostConfig,
  };
}
