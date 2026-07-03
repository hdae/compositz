// The single seam between the React app and Tauri. Every command/stream in the
// IPC contract is a typed function here; nothing else imports @tauri-apps/api
// directly, so the mock/real split lives in one place.

import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import type { ContainerSummary } from "./types";

export type { ContainerSummary } from "./types";

/**
 * Install the dev IPC mock when running outside a Tauri webview (plain
 * `vp dev` in a browser). No-op under real Tauri and in production builds: the
 * mock module is dynamically imported only when `import.meta.env.DEV`, so the
 * bundler drops it from the production graph. Returns a disposer (a no-op when
 * no mock was installed).
 */
export async function installMockIfNeeded(): Promise<() => void> {
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    const { installBrowserMock } = await import("./mock");
    return installBrowserMock();
  }
  return () => {};
}

/** Whether a real Tauri backend is present (false in browser-dev). */
export function hasTauriBackend(): boolean {
  return isTauri();
}

/** `list_containers()` — managed containers, including stopped ones. */
export async function listContainers(): Promise<ContainerSummary[]> {
  return invoke<ContainerSummary[]>("list_containers");
}

/**
 * `stream_logs(container_id, on_log)` — follow=true, tail=200, stdout+stderr.
 * `onLine` fires once per log line (no trailing newline). Returns a disposer;
 * NOTE: Phase 0 has no backend cancel command, so the disposer only detaches
 * the local handler — backing off the stream itself waits for Phase 3.
 */
export async function streamLogs(
  containerId: string,
  onLine: (line: string) => void,
): Promise<() => void> {
  const channel = new Channel<string>();
  let active = true;
  channel.onmessage = (line) => {
    if (active) onLine(line);
  };
  await invoke("stream_logs", { containerId, onLog: channel });
  return () => {
    active = false;
  };
}

/**
 * `stream_events(on_event)` — Docker system events as compact single-line
 * summaries. `onLine` fires once per event line. Returns a detach disposer
 * (same Phase 0 caveat as streamLogs).
 */
export async function streamEvents(onLine: (line: string) => void): Promise<() => void> {
  const channel = new Channel<string>();
  let active = true;
  channel.onmessage = (line) => {
    if (active) onLine(line);
  };
  await invoke("stream_events", { onEvent: channel });
  return () => {
    active = false;
  };
}
