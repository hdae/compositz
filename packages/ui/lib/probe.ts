import type { DockerEndpoint } from "@compositz/core";
import type { ContainerStatus } from "./dashboard.ts";

// SERVER-ONLY: probes published WEB ports with a real HTTP request, so a Service's
// `ready` means the app ANSWERS — not merely that Docker published the mapping.
// Two measured traps this design answers:
//   - the port mapping appears in `ps` the moment the container starts, minutes
//     before a heavy AI app listens;
//   - a bare TCP connect is USELESS as a probe: docker-proxy itself accepts the
//     connection even when nothing listens in the container (measured) — only an
//     actual HTTP exchange proves the app is behind it.
// Probing is limited to the manifest's `web: true` ports (browser UIs, http by
// the product's own URL scheme) — probing an arbitrary TCP port with HTTP would
// read as "never ready" and keep the warming poll spinning forever.

const PROBE_TIMEOUT_MS = 800;

/** True iff an HTTP request to `hostname:port` gets ANY response (incl. 4xx/5xx/30x). */
async function accepts(hostname: string, port: number): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`http://${hostname}:${port}/`, {
      signal: ctl.signal,
      redirect: "manual",
    });
    await res.body?.cancel();
    return true; // any HTTP answer = the app is up (404/401/redirect all count)
  } catch {
    return false; // refused / reset by docker-proxy / timeout / non-HTTP
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Enrich container statuses with per-port `accepting` (parallel HTTP probes).
 * Probed: running containers' ports that `webContainerPorts` names for their
 * instance (instanceId → the manifest's `web: true` container ports). Everything
 * else passes through unprobed (`accepting` stays undefined ⇒ never a false "ready").
 */
export async function probeAccepting(
  statuses: ContainerStatus[],
  hostname: string,
  webContainerPorts: Map<string, Set<number>>,
): Promise<ContainerStatus[]> {
  return await Promise.all(statuses.map(async (s) => {
    const webPorts = s.instance ? webContainerPorts.get(s.instance) : undefined;
    return {
      ...s,
      ports: await Promise.all(
        s.ports.map(async (p) =>
          s.state === "running" && webPorts?.has(p.container)
            ? { ...p, accepting: await accepts(hostname, p.public) }
            : p
        ),
      ),
    };
  }));
}

/**
 * The host where published ports actually live — the Docker DAEMON's host
 * (loopback for the local unix/npipe daemon, the remote host for a TCP endpoint).
 */
export function probeHost(endpoint: DockerEndpoint): string {
  return endpoint.kind === "tcp" ? endpoint.host : "127.0.0.1";
}
