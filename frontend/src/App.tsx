import { useEffect } from "react";
import { ContainerList } from "@/components/ContainerList";
import { StreamPane } from "@/components/StreamPane";
import { Button } from "@/components/ui/button";
import { hasTauriBackend, installMockIfNeeded } from "@/ipc";
import { useContainersStore } from "@/store/containers";

export const App = () => {
  const containers = useContainersStore((s) => s.containers);
  const loading = useContainersStore((s) => s.loading);
  const error = useContainersStore((s) => s.error);
  const selectedId = useContainersStore((s) => s.selectedId);
  const logs = useContainersStore((s) => s.logs);
  const events = useContainersStore((s) => s.events);
  const refresh = useContainersStore((s) => s.refresh);
  const selectContainer = useContainersStore((s) => s.selectContainer);
  const startEvents = useContainersStore((s) => s.startEvents);
  const teardown = useContainersStore((s) => s.teardown);

  useEffect(() => {
    let disposed = false;
    let disposeMock: (() => void) | undefined;

    // Install the browser-dev mock (no-op under real Tauri / in prod), then do
    // the initial load and start the shared event stream.
    void installMockIfNeeded().then((dispose) => {
      if (disposed) {
        dispose();
        return;
      }
      disposeMock = dispose;
      void refresh();
      void startEvents();
    });

    return () => {
      disposed = true;
      teardown();
      disposeMock?.();
    };
  }, [refresh, startEvents, teardown]);

  const backend = hasTauriBackend() ? "Tauri" : "browser (mock IPC)";

  return (
    <div className="mx-auto flex h-screen max-w-6xl flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">compositz</h1>
          <p className="text-muted-foreground text-sm">Managed containers · backend: {backend}</p>
        </div>
        <Button onClick={() => void refresh()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </header>

      {error !== undefined && (
        <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-4 py-2 text-sm">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1">
        <ContainerList
          containers={containers}
          selectedId={selectedId}
          loading={loading}
          onSelect={(id) => void selectContainer(id)}
        />
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-2 gap-4">
        <StreamPane
          title={selectedId !== undefined ? "Logs" : "Logs (select a container)"}
          lines={logs}
          emptyHint="Select a container to stream its logs."
        />
        <StreamPane title="Docker events" lines={events} emptyHint="Waiting for Docker events…" />
      </div>
    </div>
  );
};
