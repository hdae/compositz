import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ContainerSummary } from "@/ipc";

// Mock the IPC seam so the store test asserts store behavior, not Tauri wiring.
const listContainers = vi.fn<() => Promise<ContainerSummary[]>>();
const streamLogs = vi.fn<(id: string, onLine: (line: string) => void) => Promise<() => void>>();
const streamEvents = vi.fn<(onLine: (line: string) => void) => Promise<() => void>>();

vi.mock("@/ipc", () => ({
  listContainers: () => listContainers(),
  streamLogs: (id: string, onLine: (line: string) => void) => streamLogs(id, onLine),
  streamEvents: (onLine: (line: string) => void) => streamEvents(onLine),
}));

const { useContainersStore } = await import("./containers");

const FIXTURE: ContainerSummary[] = [
  {
    id: "c1",
    name: "compositz-one",
    state: "running",
    image: "compositz/one:latest",
    ports: ["8188->8188/tcp"],
  },
];

function resetStore() {
  useContainersStore.setState({
    containers: [],
    loading: false,
    error: undefined,
    selectedId: undefined,
    logs: [],
    events: [],
    logsDisposer: undefined,
    eventsDisposer: undefined,
  });
}

describe("useContainersStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
  });

  describe("refresh", () => {
    it("loads containers into the store and clears loading", async () => {
      listContainers.mockResolvedValue(FIXTURE);

      await useContainersStore.getState().refresh();

      const state = useContainersStore.getState();
      expect(state.containers).toEqual(FIXTURE);
      expect(state.loading).toBe(false);
      expect(state.error).toBeUndefined();
    });

    it("records the error as a string and stops loading on failure", async () => {
      listContainers.mockRejectedValue("engine unreachable");

      await useContainersStore.getState().refresh();

      const state = useContainersStore.getState();
      expect(state.containers).toEqual([]);
      expect(state.loading).toBe(false);
      expect(state.error).toBe("engine unreachable");
    });
  });

  describe("selectContainer", () => {
    it("streams the selected container's log lines into the store", async () => {
      let emit: ((line: string) => void) | undefined;
      streamLogs.mockImplementation(async (_id, onLine) => {
        emit = onLine;
        return () => {};
      });

      await useContainersStore.getState().selectContainer("c1");
      expect(useContainersStore.getState().selectedId).toBe("c1");

      emit?.("line one");
      emit?.("line two");

      expect(useContainersStore.getState().logs).toEqual(["line one", "line two"]);
    });

    it("disposes the previous log stream when a new container is selected", async () => {
      const firstDispose = vi.fn();
      streamLogs
        .mockImplementationOnce(async () => firstDispose)
        .mockImplementationOnce(async () => () => {});

      await useContainersStore.getState().selectContainer("c1");
      await useContainersStore.getState().selectContainer("c2");

      expect(firstDispose).toHaveBeenCalledOnce();
      expect(useContainersStore.getState().selectedId).toBe("c2");
      // Switching containers must reset the log buffer.
      expect(useContainersStore.getState().logs).toEqual([]);
    });
  });

  describe("startEvents", () => {
    it("subscribes only once even if called repeatedly", async () => {
      streamEvents.mockResolvedValue(() => {});

      await useContainersStore.getState().startEvents();
      await useContainersStore.getState().startEvents();

      expect(streamEvents).toHaveBeenCalledOnce();
    });
  });
});
