// The dashboard store. Holds the base rows (from `list_instance_rows`) and the live
// snapshot (from `subscribe_instances`), and drives the up / down / install / delete /
// duplicate / import actions.
//
// Deliberately NO optimistic updates (a hard user preference): an action never guesses
// the outcome. `running` + published ports come only from the snapshot stream;
// `installed` flips only when `instance_install` reports `done`. Structural changes
// (import, duplicate, delete) mutate the store's `baseRows` ONLY by refetching
// `list_instance_rows` AFTER the server confirms — so `baseRows` is always a derived
// view of server truth, never a hand-maintained insert/remove that could diverge. While
// an action is in flight the row shows a transient `busy` / `deleting` / `duplicating`
// spinner — an "in progress" signal, not a guessed outcome.

import { useMemo } from "react";
import { create } from "zustand";
import { mergeRow } from "@/lib/rows";
import type { LiveSnapshot } from "@/lib/rows";
import {
  deleteInstance,
  duplicateInstance,
  importGithub,
  importRecipe,
  installInstance,
  instanceDown,
  instanceUp,
  listInstanceRows,
  openServiceUrl,
  pickRecipeFile,
  renameInstance,
  subscribeInstances,
  updateCommit,
  updateDiscard,
  updatePrepare,
} from "@/ipc/client";
import type {
  DeleteOpts,
  InstanceRow,
  InstanceView,
  PortBump,
  Subscription,
  UpdatePreview,
} from "@/ipc/client";

/** The three run-state actions that spin the primary Start/Stop/Install control. */
export type BusyKind = "starting" | "stopping" | "installing";

/** The detail-panel tabs. The active one follows an explicit pick, else a per-state default. */
export type TabKey = "build" | "logs" | "services" | "settings";

/** A freshly-imported instance awaiting the trust ("install?") decision. */
export type TrustState = { view: InstanceView; source: string; bumps: PortBump[] };

/** The GitHub-import modal state: the in-progress spec, whether a fetch is running, last error. */
export type GithubState = { spec: string; submitting: boolean; error: string | undefined };

/** The rename dialog state: the target row and the name being edited. */
export type RenameState = { row: InstanceRow; name: string; saving: boolean };

/**
 * The update dialog state. `input` = editing the ref; `fetching` = prepare in
 * flight; `preview` = staged, awaiting the re-trust decision; `committing` =
 * applying. The preview is present from `preview` on.
 */
export type UpdateState = {
  row: InstanceRow;
  ref: string;
  phase: "input" | "fetching" | "preview" | "committing";
  preview: UpdatePreview | undefined;
  error: string | undefined;
};

type InstancesState = {
  baseRows: InstanceRow[];
  snapshot: LiveSnapshot;
  /** Rows that flipped to installed since load (via an `instance_install` `done`). */
  installedOverride: Record<string, boolean>;
  busy: Record<string, BusyKind>;
  /** A duplicate is in flight for this instance (separate from run-state busy). */
  duplicating: Record<string, boolean>;
  /** A delete is in flight for this instance — its row controls are disabled meanwhile. */
  deleting: Record<string, boolean>;
  /** Accumulated build-log lines per instance (the streaming install output). */
  buildLog: Record<string, string[]>;
  expanded: Record<string, boolean>;
  /** The explicitly-selected detail tab per instance (absent ⇒ a per-state default). */
  tabByInstance: Record<string, TabKey>;
  loading: boolean;
  ready: boolean;
  error: string | undefined;
  /** Non-error info (port reassignments, partial-outcome delete warnings). */
  notice: string | undefined;
  /** A recipe import (file pick + ingest) is running. */
  importing: boolean;
  /** The trust gate: a just-imported recipe awaiting an install / discard choice. */
  trust: TrustState | undefined;
  /** The GitHub-import modal, when open. */
  github: GithubState | undefined;
  /** The instance whose delete-confirm dialog is open. */
  deleteTarget: InstanceRow | undefined;
  /** The rename dialog, when open. */
  rename: RenameState | undefined;
  /** The in-place update dialog, when open. */
  update: UpdateState | undefined;

  init: () => Promise<void>;
  refresh: () => Promise<void>;
  reloadRows: () => Promise<void>;
  up: (id: string) => Promise<void>;
  down: (id: string) => Promise<void>;
  restart: (id: string) => Promise<void>;
  install: (id: string) => Promise<void>;
  open: (url: string) => Promise<void>;
  duplicate: (id: string) => Promise<void>;
  requestDelete: (row: InstanceRow) => void;
  cancelDelete: () => void;
  requestRename: (row: InstanceRow) => void;
  setRenameName: (name: string) => void;
  cancelRename: () => void;
  submitRename: () => Promise<void>;
  requestUpdate: (row: InstanceRow) => void;
  setUpdateRef: (ref: string) => void;
  cancelUpdate: () => void;
  checkUpdate: () => Promise<void>;
  confirmUpdate: () => Promise<void>;
  remove: (id: string, opts: DeleteOpts) => Promise<void>;
  beginImportFile: () => Promise<void>;
  importFromPath: (source: string) => Promise<void>;
  openGithub: () => void;
  setGithubSpec: (spec: string) => void;
  closeGithub: () => void;
  submitGithub: () => Promise<void>;
  trustInstall: () => Promise<void>;
  trustReject: () => Promise<void>;
  setTab: (id: string, tab: TabKey) => void;
  toggleExpanded: (id: string) => void;
  dismissError: () => void;
  dismissNotice: () => void;
  teardown: () => void;
};

// Subscription lifecycle lives outside the reactive state (disposing a stream must
// not trigger a re-render). `sessionToken` supersedes a prior init: React StrictMode
// mounts → unmounts → mounts, so an async subscribe from a torn-down session must not
// win. Each init captures the token; any set/subscribe from a stale token is dropped.
let sessionToken = 0;
let snapshotSub: Subscription | undefined;
const installSubs = new Map<string, Subscription>();

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

/** The user-facing notice for a duplicate whose host ports had to be reassigned. */
function duplicateBumpNotice(id: string, bumps: PortBump[]): string {
  const list = bumps.map((b) => `${b.name} ${b.from}→${b.to}`).join(", ");
  return `Duplicated as ${id} — host port reassigned: ${list}. You can change it in Settings.`;
}

export const useInstancesStore = create<InstancesState>((set, get) => ({
  baseRows: [],
  snapshot: { kind: "connecting" },
  installedOverride: {},
  busy: {},
  duplicating: {},
  deleting: {},
  buildLog: {},
  expanded: {},
  tabByInstance: {},
  loading: false,
  ready: false,
  error: undefined,
  notice: undefined,
  importing: false,
  trust: undefined,
  github: undefined,
  deleteTarget: undefined,
  rename: undefined,
  update: undefined,

  init: async () => {
    const token = ++sessionToken;
    if (snapshotSub) {
      void snapshotSub.unsubscribe();
      snapshotSub = undefined;
    }
    set({ loading: true, error: undefined });

    try {
      const rows = await listInstanceRows();
      if (token !== sessionToken) return;
      set({ baseRows: rows, loading: false, ready: true });
    } catch (error) {
      if (token !== sessionToken) return;
      set({ loading: false, ready: true, error: describe(error) });
    }

    // Subscribe even if the initial list failed — the engine may recover, and the
    // stream reports offline/online transitions.
    try {
      const sub = await subscribeInstances((event) => {
        if (token !== sessionToken) return; // late event from a superseded session
        set({
          snapshot:
            event.type === "snapshot"
              ? { kind: "online", containers: event.containers }
              : { kind: "offline", error: event.error },
        });
      });
      if (token !== sessionToken) {
        void sub.unsubscribe();
        return;
      }
      snapshotSub = sub;
    } catch (error) {
      if (token !== sessionToken) return;
      set({ snapshot: { kind: "offline", error: describe(error) } });
    }
  },

  refresh: async () => {
    set({ loading: true, error: undefined });
    try {
      const rows = await listInstanceRows();
      set({ baseRows: rows, loading: false });
    } catch (error) {
      set({ loading: false, error: describe(error) });
    }
  },

  // Quiet refetch of `baseRows` after a confirmed structural mutation — no page-level
  // loading flag (the acting row already shows its own spinner). This is the ONLY way
  // rows are added/removed, so the list stays a pure function of server truth.
  reloadRows: async () => {
    const token = sessionToken;
    try {
      const rows = await listInstanceRows();
      if (token !== sessionToken) return;
      set({ baseRows: rows });
    } catch (error) {
      if (token !== sessionToken) return;
      set({ error: describe(error) });
    }
  },

  up: async (id) => {
    // Starting → open the panel on the runtime log so the app's own startup output is
    // in view (the action-driven tab flow: install→build, build done→settings,
    // start→runtime log, ready→services).
    set((s) => ({
      busy: { ...s.busy, [id]: "starting" },
      expanded: { ...s.expanded, [id]: true },
      tabByInstance: { ...s.tabByInstance, [id]: "logs" },
      error: undefined,
    }));
    try {
      await instanceUp(id);
      // `running` is confirmed by the snapshot stream, not set here.
    } catch (error) {
      set({ error: describe(error) });
    } finally {
      set((s) => ({ busy: without(s.busy, id) }));
    }
  },

  down: async (id) => {
    set((s) => ({ busy: { ...s.busy, [id]: "stopping" }, error: undefined }));
    try {
      await instanceDown(id);
    } catch (error) {
      set({ error: describe(error) });
    } finally {
      set((s) => ({ busy: without(s.busy, id) }));
    }
  },

  // Restart in place to apply a just-saved override (down → up). Unlike `up`, it does
  // NOT switch the detail tab — the user stays on Settings where they clicked Restart.
  restart: async (id) => {
    set((s) => ({ busy: { ...s.busy, [id]: "stopping" }, error: undefined }));
    try {
      await instanceDown(id);
      set((s) => ({ busy: { ...s.busy, [id]: "starting" } }));
      await instanceUp(id);
    } catch (error) {
      set({ error: describe(error) });
    } finally {
      set((s) => ({ busy: without(s.busy, id) }));
    }
  },

  install: async (id) => {
    set((s) => ({
      busy: { ...s.busy, [id]: "installing" },
      buildLog: { ...s.buildLog, [id]: [] },
      expanded: { ...s.expanded, [id]: true },
      tabByInstance: { ...s.tabByInstance, [id]: "build" },
      error: undefined,
    }));

    const append = (id: string, line: string) =>
      set((s) => ({ buildLog: { ...s.buildLog, [id]: [...(s.buildLog[id] ?? []), line] } }));

    const disposeInstall = (id: string) => {
      const sub = installSubs.get(id);
      if (sub) {
        void sub.unsubscribe();
        installSubs.delete(id);
      }
    };

    try {
      const sub = await installInstance(id, (event) => {
        switch (event.type) {
          case "log":
            append(id, event.line);
            break;
          case "error":
            append(id, `error: ${event.error}`);
            set((s) => ({ busy: without(s.busy, id), error: event.error }));
            disposeInstall(id);
            break;
          case "done":
            append(id, `✓ built ${event.tag}`);
            // Build finished → configuration is the natural next step before first start.
            // A FAILED build keeps the build tab (the error stays in view).
            set((s) => ({
              busy: without(s.busy, id),
              installedOverride: { ...s.installedOverride, [id]: true },
              tabByInstance: { ...s.tabByInstance, [id]: "settings" },
            }));
            disposeInstall(id);
            break;
        }
      });
      installSubs.set(id, sub);
    } catch (error) {
      set((s) => ({ busy: without(s.busy, id), error: describe(error) }));
    }
  },

  open: async (url) => {
    try {
      await openServiceUrl(url);
    } catch (error) {
      set({ error: describe(error) });
    }
  },

  // Duplicate = a fresh deployment of the same app: bundle + settings minus ports (they
  // are reassigned server-side), no data. Server-confirmed: the new row appears only
  // from the refetch, and any port reassignment is surfaced as a notice.
  duplicate: async (id) => {
    set((s) => ({
      duplicating: { ...s.duplicating, [id]: true },
      error: undefined,
      notice: undefined,
    }));
    try {
      const { view, bumps } = await duplicateInstance(id);
      await get().reloadRows();
      if (bumps.length) set({ notice: duplicateBumpNotice(view.instanceId, bumps) });
    } catch (error) {
      set({ error: `duplicate ${id} failed: ${describe(error)}` });
    } finally {
      set((s) => ({ duplicating: without(s.duplicating, id) }));
    }
  },

  requestDelete: (row) => set({ deleteTarget: row }),
  cancelDelete: () => set({ deleteTarget: undefined }),

  requestRename: (row) => set({ rename: { row, name: row.name, saving: false } }),
  setRenameName: (name) => set((s) => (s.rename ? { rename: { ...s.rename, name } } : {})),
  cancelRename: () => set((s) => (s.rename && !s.rename.saving ? { rename: undefined } : {})),

  // Persist the display name server-side, then reflect it via the row refetch
  // (server-confirmed, like every structural change). An empty name clears the
  // override — the row returns to the recipe's own name.
  submitRename: async () => {
    const r = get().rename;
    if (!r || r.saving) return;
    set({ rename: { ...r, saving: true } });
    try {
      const trimmed = r.name.trim();
      await renameInstance(r.row.instanceId, trimmed === "" ? null : trimmed);
      set({ rename: undefined });
      await get().reloadRows();
    } catch (error) {
      set({
        rename: undefined,
        error: `rename ${r.row.instanceId} failed: ${describe(error)}`,
      });
    }
  },

  // Delete server-side, then drop the row via a refetch — the row lingers with a
  // `deleting` spinner through the round-trip rather than being optimistically removed
  // (and rolled back on failure). On success the per-id transient state is cleaned up.
  remove: async (id, opts) => {
    set((s) => ({ deleting: { ...s.deleting, [id]: true }, error: undefined, notice: undefined }));
    try {
      const { warning } = await deleteInstance(id, opts);
      await get().reloadRows();
      set((s) => ({
        buildLog: without(s.buildLog, id),
        expanded: without(s.expanded, id),
        tabByInstance: without(s.tabByInstance, id),
        installedOverride: without(s.installedOverride, id),
        notice: warning ? `delete ${id}: ${warning}` : s.notice,
      }));
    } catch (error) {
      set({ error: `delete ${id} failed: ${describe(error)}` });
    } finally {
      set((s) => ({ deleting: without(s.deleting, id) }));
    }
  },

  // Import a recipe bundle: pick a path, ingest it server-side (the instance exists on
  // disk but stays HIDDEN — not refetched into the list — until the trust gate is
  // answered), then open the trust gate.
  beginImportFile: async () => {
    const source = await pickRecipeFile();
    if (source === undefined) return; // user cancelled the picker
    await get().importFromPath(source);
  },

  // Ingest a recipe bundle from a known path (file picker or a window drop) → the
  // instance exists on disk but stays HIDDEN until the trust gate is answered.
  importFromPath: async (source) => {
    set({ importing: true, error: undefined });
    try {
      const { view, bumps } = await importRecipe(source);
      set({ importing: false, trust: { view, source, bumps } });
    } catch (error) {
      set({ importing: false, error: `import failed: ${describe(error)}` });
    }
  },

  openGithub: () => set({ github: { spec: "", submitting: false, error: undefined } }),
  setGithubSpec: (spec) => set((s) => (s.github ? { github: { ...s.github, spec } } : {})),
  closeGithub: () => set((s) => (s.github && !s.github.submitting ? { github: undefined } : {})),

  // GitHub import: download + ingest the codeload tarball, then hand off to the trust
  // gate (same server-confirmed hidden-until-trusted flow as a file import). On failure
  // keep the modal open with the error so the spec can be fixed and retried.
  submitGithub: async () => {
    const g = get().github;
    const spec = g?.spec.trim();
    if (!g || !spec || g.submitting) return;
    set({ github: { ...g, submitting: true, error: undefined } });
    try {
      const { view, bumps } = await importGithub(spec);
      set({ github: undefined, trust: { view, source: `github:${spec}`, bumps } });
    } catch (error) {
      set((s) => ({
        github: s.github ? { ...s.github, submitting: false, error: describe(error) } : undefined,
      }));
    }
  },

  // Trust = Yes: reveal the imported row (it is already on disk — server-confirmed, not
  // optimistic) and build it now, streaming the log into its panel.
  trustInstall: async () => {
    const t = get().trust;
    if (!t) return;
    set({ trust: undefined });
    await get().reloadRows();
    await get().install(t.view.instanceId);
  },

  // Trust = No: the just-imported instance is removed entirely (nothing was built).
  trustReject: async () => {
    const t = get().trust;
    if (!t) return;
    set({ trust: undefined });
    await get().remove(t.view.instanceId, { volumes: true, bindData: false });
  },

  // Open the update dialog with the ref prefilled from the recorded source
  // (`github:owner/repo[/subdir][@ref]` — the part after the last `@`, if any).
  requestUpdate: (row) => {
    const source = row.source ?? "";
    const at = source.lastIndexOf("@");
    const ref = at === -1 ? "" : source.slice(at + 1);
    set({ update: { row, ref, phase: "input", preview: undefined, error: undefined } });
  },

  setUpdateRef: (ref) =>
    set((s) => (s.update && s.update.phase === "input" ? { update: { ...s.update, ref } } : {})),

  // Close the dialog. A staged (previewed) update is discarded server-side —
  // fire-and-forget, a new prepare replaces any leftover staging anyway. Mid-flight
  // phases can't cancel (the backend call is already running).
  cancelUpdate: () => {
    const u = get().update;
    if (!u || u.phase === "fetching" || u.phase === "committing") return;
    if (u.phase === "preview") {
      void updateDiscard(u.row.instanceId).catch(() => {});
    }
    set({ update: undefined });
  },

  // Prepare: download + stage the (new) ref, then show the re-trust preview. On
  // failure stay on the input phase with the error, so the ref can be corrected.
  checkUpdate: async () => {
    const u = get().update;
    if (!u || u.phase !== "input") return;
    set({ update: { ...u, phase: "fetching", error: undefined } });
    try {
      const preview = await updatePrepare(u.row.instanceId, u.ref.trim());
      set((s) => (s.update ? { update: { ...s.update, phase: "preview", preview } } : {}));
    } catch (error) {
      set((s) =>
        s.update ? { update: { ...s.update, phase: "input", error: describe(error) } } : {},
      );
    }
  },

  // Trust = update: swap the bundle server-side (stops the old container), then
  // reflect via refetch and rebuild with the streamed install log — the same
  // action-driven flow as a fresh import's trust.
  confirmUpdate: async () => {
    const u = get().update;
    if (!u || u.phase !== "preview") return;
    set({ update: { ...u, phase: "committing" } });
    try {
      await updateCommit(u.row.instanceId);
      set({ update: undefined });
      await get().reloadRows();
      await get().install(u.row.instanceId);
    } catch (error) {
      set({ update: undefined, error: `update ${u.row.instanceId} failed: ${describe(error)}` });
    }
  },

  setTab: (id, tab) => set((s) => ({ tabByInstance: { ...s.tabByInstance, [id]: tab } })),

  toggleExpanded: (id) =>
    set((s) => ({ expanded: { ...s.expanded, [id]: !(s.expanded[id] ?? false) } })),

  dismissError: () => set({ error: undefined }),
  dismissNotice: () => set({ notice: undefined }),

  teardown: () => {
    sessionToken++; // invalidate the running session
    if (snapshotSub) {
      void snapshotSub.unsubscribe();
      snapshotSub = undefined;
    }
    for (const sub of installSubs.values()) void sub.unsubscribe();
    installSubs.clear();
  },
}));

/** One dashboard row ready to render: the live-merged row plus its transient UI state. */
export type RowVM = {
  row: InstanceRow;
  busy: BusyKind | undefined;
  duplicating: boolean;
  deleting: boolean;
  buildLog: string[] | undefined;
  expanded: boolean;
  /** The explicitly-picked detail tab, if any (the panel falls back to a per-state default). */
  tab: TabKey | undefined;
};

/** Merge the base rows with the live snapshot into render-ready view-models. */
export function useRowVMs(): RowVM[] {
  const baseRows = useInstancesStore((s) => s.baseRows);
  const snapshot = useInstancesStore((s) => s.snapshot);
  const installedOverride = useInstancesStore((s) => s.installedOverride);
  const busy = useInstancesStore((s) => s.busy);
  const duplicating = useInstancesStore((s) => s.duplicating);
  const deleting = useInstancesStore((s) => s.deleting);
  const buildLog = useInstancesStore((s) => s.buildLog);
  const expanded = useInstancesStore((s) => s.expanded);
  const tabByInstance = useInstancesStore((s) => s.tabByInstance);

  return useMemo(
    () =>
      baseRows.map((base) => ({
        row: mergeRow(base, snapshot, installedOverride),
        busy: busy[base.instanceId],
        duplicating: duplicating[base.instanceId] ?? false,
        deleting: deleting[base.instanceId] ?? false,
        buildLog: buildLog[base.instanceId],
        expanded: expanded[base.instanceId] ?? false,
        tab: tabByInstance[base.instanceId],
      })),
    [
      baseRows,
      snapshot,
      installedOverride,
      busy,
      duplicating,
      deleting,
      buildLog,
      expanded,
      tabByInstance,
    ],
  );
}
