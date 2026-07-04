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
  DeleteOpts,
  DeleteView,
  ImportView,
  InstallEvent,
  InstanceRow,
  InstanceSettings,
  LogEvent,
  Override,
  Result,
  SetConfigView,
  SnapshotEvent,
  UpdatePreview,
  UpView,
} from "./bindings";

export type {
  DeleteOpts,
  DeleteView,
  EnvSetting,
  ImportView,
  InstallEvent,
  InstanceRow,
  InstanceSettings,
  InstanceView,
  LogEvent,
  MountSetting,
  Override,
  Placement,
  PortBump,
  PortSetting,
  Service,
  SetConfigView,
  SnapshotEvent,
  UpdatePreview,
  UpView,
} from "./bindings";

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

/**
 * Delete an instance: container + built image + (per `opts`) data volumes / bind data,
 * then its definition. Returns a partial-outcome warning (non-fatal) if any.
 */
export async function deleteInstance(id: string, opts: DeleteOpts): Promise<DeleteView> {
  return unwrap(await commands.instanceDelete(id, opts));
}

/** Derive a fresh instance from an existing one (settings minus ports, no data). */
export async function duplicateInstance(id: string): Promise<ImportView> {
  return unwrap(await commands.instanceDuplicate(id));
}

/** Import a recipe bundle from a local path (tar / tar.gz / directory) into a new instance. */
export async function importRecipe(source: string): Promise<ImportView> {
  return unwrap(await commands.importRecipe(source));
}

/**
 * Set or clear the per-instance display name. `null` — or a name that trims to
 * empty / equals the manifest brand — clears the override (display returns to
 * tracking the recipe's own name).
 */
export async function renameInstance(id: string, name: string | null): Promise<void> {
  unwrap(await commands.renameInstance(id, name));
}

/** Import a recipe from a GitHub spec (`owner/repo[/subdir][@ref]`, public repos only). */
export async function importGithub(spec: string): Promise<ImportView> {
  return unwrap(await commands.importGithub(spec));
}

/**
 * Stage an in-place update (GitHub-sourced instances only) and return the
 * re-trust preview. `newRef` overrides the recorded ref; empty ⇒ default branch.
 * Nothing live changes until `updateCommit`.
 */
export async function updatePrepare(id: string, newRef: string): Promise<UpdatePreview> {
  return unwrap(await commands.updatePrepare(id, newRef));
}

/** Apply a prepared update: swap the bundle, stop the old container, reclaim the old image. */
export async function updateCommit(id: string): Promise<void> {
  unwrap(await commands.updateCommit(id));
}

/** Drop a prepared update (idempotent); the instance is untouched. */
export async function updateDiscard(id: string): Promise<void> {
  unwrap(await commands.updateDiscard(id));
}

/**
 * Pick a recipe bundle via the OS-native file picker (dialog plugin) and return its
 * path, or `undefined` if the user cancelled. Under plain `vp dev` (no Tauri) there is
 * no native picker, so a synthetic path is handed to the dev mock instead.
 */
export async function pickRecipeFile(): Promise<string | undefined> {
  if (!hasTauriBackend()) return "mock://recipe.tar";
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Recipe bundle", extensions: ["tar", "gz", "tgz"] }],
  });
  return typeof selected === "string" ? selected : undefined;
}

/** Export one persisted mount's data as a tar written to `dest` (works on a stopped instance). */
export async function exportMount(id: string, mount: string, dest: string): Promise<void> {
  unwrap(await commands.exportMount(id, mount, dest));
}

/**
 * Pick a save destination via the OS-native save dialog; `undefined` if cancelled. Under
 * plain `vp dev` (no Tauri) there is no dialog, so a synthetic path is handed to the mock.
 */
export async function pickSaveDest(defaultName: string): Promise<string | undefined> {
  if (!hasTauriBackend()) return `mock://${defaultName}`;
  const { save } = await import("@tauri-apps/plugin-dialog");
  const dest = await save({
    defaultPath: defaultName,
    filters: [{ name: "Tar archive", extensions: ["tar"] }],
  });
  return dest ?? undefined;
}

/** The Settings view-model for an instance (manifest ⊕ saved override, restartNeeded). */
export async function getConfig(id: string): Promise<InstanceSettings> {
  return unwrap(await commands.getConfig(id));
}

/** Persist a launch override (validated server-side); returns whether a restart is needed. */
export async function setConfig(id: string, over: Override): Promise<SetConfigView> {
  return unwrap(await commands.setConfig(id, over));
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

/** Stream a running container's logs until end/error (or `unsubscribe`). */
export async function streamLogs(
  id: string,
  onLog: (event: LogEvent) => void,
): Promise<Subscription> {
  const channel = new Channel<LogEvent>();
  channel.onmessage = onLog;
  const subscriptionId = unwrap(await commands.streamLogs(id, channel));
  return { unsubscribe: () => stopPump(subscriptionId) };
}
