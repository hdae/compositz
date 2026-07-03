// App state for the walking skeleton: the container list plus the currently
// selected container's live log stream and a shared event stream. State is
// push-shaped (Channel -> store), which is why zustand fits better than a
// pull/cache library here (see docs/plans/tauri-migration.md).

import { create } from "zustand";
import { listContainers, streamEvents, streamLogs, type ContainerSummary } from "@/ipc";

/** Cap retained lines so a long-running stream can't grow unbounded. */
const MAX_LINES = 500;

type Disposer = () => void;

type ContainersState = {
  containers: ContainerSummary[];
  loading: boolean;
  error: string | undefined;

  selectedId: string | undefined;
  logs: string[];
  events: string[];

  // Kept out of render but on the store so actions can tear down prior streams.
  logsDisposer: Disposer | undefined;
  eventsDisposer: Disposer | undefined;

  refresh: () => Promise<void>;
  selectContainer: (id: string) => Promise<void>;
  startEvents: () => Promise<void>;
  teardown: () => void;
};

/** Append to a bounded line buffer, dropping the oldest when over the cap. */
function appendBounded(buffer: string[], line: string): string[] {
  const next = [...buffer, line];
  return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
}

export const useContainersStore = create<ContainersState>((set, get) => ({
  containers: [],
  loading: false,
  error: undefined,

  selectedId: undefined,
  logs: [],
  events: [],

  logsDisposer: undefined,
  eventsDisposer: undefined,

  refresh: async () => {
    set({ loading: true, error: undefined });
    try {
      const containers = await listContainers();
      set({ containers, loading: false });
    } catch (cause) {
      set({ loading: false, error: String(cause) });
    }
  },

  selectContainer: async (id: string) => {
    // Detach any prior log handler before starting a new one.
    get().logsDisposer?.();
    set({ selectedId: id, logs: [], logsDisposer: undefined });
    try {
      const disposer = await streamLogs(id, (line) => {
        set((state) => ({ logs: appendBounded(state.logs, line) }));
      });
      // A newer selection may have won the race while we awaited; if so, drop
      // this stream immediately instead of leaking it.
      if (get().selectedId === id) {
        set({ logsDisposer: disposer });
      } else {
        disposer();
      }
    } catch (cause) {
      set({ error: String(cause) });
    }
  },

  startEvents: async () => {
    if (get().eventsDisposer) return; // already streaming
    try {
      const disposer = await streamEvents((line) => {
        set((state) => ({ events: appendBounded(state.events, line) }));
      });
      set({ eventsDisposer: disposer });
    } catch (cause) {
      set({ error: String(cause) });
    }
  },

  teardown: () => {
    get().logsDisposer?.();
    get().eventsDisposer?.();
    set({ logsDisposer: undefined, eventsDisposer: undefined });
  },
}));
