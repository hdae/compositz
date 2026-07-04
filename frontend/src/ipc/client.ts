// The single seam between the React app and the Tauri backend. Every command and
// stream in the IPC contract passes through here; nothing else imports the generated
// `bindings` or `@tauri-apps/api` directly, so the typed surface — and the
// `Result` → throw unwrapping — lives in one place.
//
// The generated `commands.*` return `Result<T, AppError>`: a Rust `Err(AppError)`
// resolves to `{ status: "error" }`, while a genuine transport/JS failure rethrows a
// real `Error`. `unwrap` collapses both into a thrown error (Error subclass — the
// project convention), so callers write straight-line `await` code with try/catch.

import { Channel, isTauri } from "@tauri-apps/api/core";
import { commands } from "./bindings";
import type {
  AppError,
  InstallEvent,
  InstanceRow,
  Result,
  SnapshotEvent,
  UpView,
} from "./bindings";

export type { InstallEvent, InstanceRow, SnapshotEvent, UpView } from "./bindings";

/** A backend error carried across IPC, with its `kind` for callers that branch on it. */
export class IpcError extends Error {
  readonly kind: AppError["kind"];
  constructor(error: AppError) {
    super(error.message);
    this.name = "IpcError";
    this.kind = error.kind;
  }
}

/** Collapse a `Result<T, AppError>` into `T`, throwing `IpcError` on the error arm. */
function unwrap<T>(result: Result<T, AppError>): T {
  if (result.status === "ok") return result.data;
  throw new IpcError(result.error);
}

/** Whether a real Tauri backend is present (false under plain `vp dev` in a browser). */
export function hasTauriBackend(): boolean {
  return isTauri();
}

/**
 * Install the dev IPC mock when running outside a Tauri webview (plain `vp dev`).
 * No-op under real Tauri and in production: the mock module is dynamically imported
 * only in DEV, so the bundler drops it from the production graph. Returns a disposer.
 */
export async function installMockIfNeeded(): Promise<() => void> {
  if (import.meta.env.DEV && !hasTauriBackend()) {
    const { installBrowserMock } = await import("./mock");
    return installBrowserMock();
  }
  return () => {};
}

// --- request/response -----------------------------------------------------

/** The initial dashboard rows (installed/running joined server-side at fetch time). */
export async function listInstanceRows(): Promise<InstanceRow[]> {
  return unwrap(await commands.listInstanceRows());
}

/** Bring an instance up (builds silently if missing); returns the published web URL. */
export async function instanceUp(id: string): Promise<UpView> {
  return unwrap(await commands.instanceUp(id));
}

/** Stop + remove an instance's container. */
export async function instanceDown(id: string): Promise<void> {
  unwrap(await commands.instanceDown(id));
}

/** Open a local service URL in the OS default browser (backend enforces localhost). */
export async function openServiceUrl(url: string): Promise<void> {
  unwrap(await commands.openServiceUrl(url));
}

// --- push streams ---------------------------------------------------------

/**
 * A live push stream. `unsubscribe` stops the backend pump (idempotent); always call
 * it on teardown so no pump outlives its consumer.
 */
export type Subscription = { unsubscribe: () => Promise<void> };

async function stopPump(subscriptionId: number): Promise<void> {
  unwrap(await commands.unsubscribe(subscriptionId));
}

/** Subscribe to managed-container snapshots (running state + published ports). */
export async function subscribeInstances(
  onEvent: (event: SnapshotEvent) => void,
): Promise<Subscription> {
  const channel = new Channel<SnapshotEvent>();
  channel.onmessage = onEvent;
  const id = unwrap(await commands.subscribeInstances(channel));
  return { unsubscribe: () => stopPump(id) };
}

/** Build (or pull) an instance's image, streaming the build log until done/error. */
export async function installInstance(
  id: string,
  onProgress: (event: InstallEvent) => void,
): Promise<Subscription> {
  const channel = new Channel<InstallEvent>();
  channel.onmessage = onProgress;
  const subscriptionId = unwrap(await commands.instanceInstall(id, channel));
  return { unsubscribe: () => stopPump(subscriptionId) };
}
