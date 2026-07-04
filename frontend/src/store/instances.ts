// The dashboard store. Holds the base rows (from `list_instance_rows`) and the live
// snapshot (from `subscribe_instances`), and drives the up / down / install actions.
//
// Deliberately NO optimistic updates (a hard user preference): an action never flips
// `running` / `installed` itself. `running` and published ports come only from the
// snapshot stream (server-confirmed); `installed` flips only when `instance_install`
// reports `done`. While an action is in flight the row shows a transient `busy`
// spinner — an "in progress" signal, not a guessed outcome — cleared when the call
// settles; the real state then arrives via the snapshot.

import { useMemo } from "react";
import { create } from "zustand";
import { mergeRow } from "@/lib/rows";
import type { LiveSnapshot } from "@/lib/rows";
import {
  installInstance,
  instanceDown,
  instanceUp,
  listInstanceRows,
  openServiceUrl,
  subscribeInstances,
} from "@/ipc/client";
import type { InstanceRow, Subscription } from "@/ipc/client";

export type BusyKind = "starting" | "stopping" | "installing";

type InstancesState = {
  baseRows: InstanceRow[];
  snapshot: LiveSnapshot;
  /** Rows that flipped to installed since load (via an `instance_install` `done`). */
  installedOverride: Record<string, boolean>;
  busy: Record<string, BusyKind>;
  /** Accumulated build-log lines per instance (the streaming install output). */
  buildLog: Record<string, string[]>;
  expanded: Record<string, boolean>;
  loading: boolean;
  ready: boolean;
  error: string | undefined;

  init: () => Promise<void>;
  refresh: () => Promise<void>;
  up: (id: string) => Promise<void>;
  down: (id: string) => Promise<void>;
  install: (id: string) => Promise<void>;
  open: (url: string) => Promise<void>;
  toggleExpanded: (id: string) => void;
  dismissError: () => void;
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

export const useInstancesStore = create<InstancesState>((set) => ({
  baseRows: [],
  snapshot: { kind: "connecting" },
  installedOverride: {},
  busy: {},
  buildLog: {},
  expanded: {},
  loading: false,
  ready: false,
  error: undefined,

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

  up: async (id) => {
    set((s) => ({ busy: { ...s.busy, [id]: "starting" }, error: undefined }));
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

  install: async (id) => {
    set((s) => ({
      busy: { ...s.busy, [id]: "installing" },
      buildLog: { ...s.buildLog, [id]: [] },
      expanded: { ...s.expanded, [id]: true },
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
            set((s) => ({
              busy: without(s.busy, id),
              installedOverride: { ...s.installedOverride, [id]: true },
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

  toggleExpanded: (id) =>
    set((s) => ({ expanded: { ...s.expanded, [id]: !(s.expanded[id] ?? false) } })),

  dismissError: () => set({ error: undefined }),

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
  buildLog: string[] | undefined;
  expanded: boolean;
};

/** Merge the base rows with the live snapshot into render-ready view-models. */
export function useRowVMs(): RowVM[] {
  const baseRows = useInstancesStore((s) => s.baseRows);
  const snapshot = useInstancesStore((s) => s.snapshot);
  const installedOverride = useInstancesStore((s) => s.installedOverride);
  const busy = useInstancesStore((s) => s.busy);
  const buildLog = useInstancesStore((s) => s.buildLog);
  const expanded = useInstancesStore((s) => s.expanded);

  return useMemo(
    () =>
      baseRows.map((base) => ({
        row: mergeRow(base, snapshot, installedOverride),
        busy: busy[base.instanceId],
        buildLog: buildLog[base.instanceId],
        expanded: expanded[base.instanceId] ?? false,
      })),
    [baseRows, snapshot, installedOverride, busy, buildLog, expanded],
  );
}
