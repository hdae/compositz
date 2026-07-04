import { useEffect } from "react";
import { RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InstanceTable } from "@/components/InstanceTable";
import { cn } from "@/lib/utils";
import { hasTauriBackend, installMockIfNeeded } from "@/ipc/client";
import { useInstancesStore } from "@/store/instances";
import { ThemeToggle } from "@/theme/ThemeToggle";

function engineStatusLabel(kind: "connecting" | "online" | "offline"): string {
  if (kind === "offline") return "engine offline";
  if (kind === "connecting") return "connecting…";
  return "engine online";
}

export const App = () => {
  const init = useInstancesStore((s) => s.init);
  const teardown = useInstancesStore((s) => s.teardown);
  const refresh = useInstancesStore((s) => s.refresh);
  const loading = useInstancesStore((s) => s.loading);
  const error = useInstancesStore((s) => s.error);
  const dismissError = useInstancesStore((s) => s.dismissError);
  const snapshot = useInstancesStore((s) => s.snapshot);

  useEffect(() => {
    let disposed = false;
    let disposeMock: (() => void) | undefined;

    // Install the browser-dev mock first (no-op under real Tauri), then load + subscribe.
    void installMockIfNeeded().then((dispose) => {
      if (disposed) {
        dispose();
        return;
      }
      disposeMock = dispose;
      void init();
    });

    return () => {
      disposed = true;
      teardown();
      disposeMock?.();
    };
  }, [init, teardown]);

  const backend = hasTauriBackend() ? "Tauri" : "browser (mock IPC)";

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">compositz</h1>
          <p className="text-sm text-muted-foreground">
            {backend} · {engineStatusLabel(snapshot.kind)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw className={cn(loading && "animate-spin")} />
            Refresh
          </Button>
          <ThemeToggle />
        </div>
      </header>

      {snapshot.kind === "offline" && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-700 dark:text-amber-400">
          Docker engine unreachable — instances are listed, but actions are disabled.{" "}
          <span className="text-amber-600/80 dark:text-amber-400/70">{snapshot.error}</span>
        </div>
      )}

      {error !== undefined && (
        <div className="flex items-start justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          <span>{error}</span>
          <button
            type="button"
            aria-label="Dismiss error"
            onClick={dismissError}
            className="shrink-0 opacity-70 hover:opacity-100"
          >
            <X className="size-4" />
          </button>
        </div>
      )}

      <InstanceTable />
    </div>
  );
};
