import { useEffect } from "react";
import { RefreshCw, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TooltipProvider } from "@/components/ui/tooltip";
import { InstanceList } from "@/components/InstanceList";
import { ImportBar } from "@/components/ImportBar";
import { DropZone } from "@/components/DropZone";
import { TrustDialog } from "@/components/TrustDialog";
import { DeleteDialog } from "@/components/DeleteDialog";
import { RenameDialog } from "@/components/RenameDialog";
import { GithubImportDialog } from "@/components/GithubImportDialog";
import { cn } from "@/lib/utils";
import { installMockIfNeeded } from "@/ipc/client";
import { useInstancesStore } from "@/store/instances";
import { ThemeToggle } from "@/theme/ThemeToggle";

/** Engine reachability, worn as a badge next to the app title. */
const EngineBadge = ({ kind }: { kind: "connecting" | "online" | "offline" }) => {
  if (kind === "online") {
    return (
      <Badge
        variant="outline"
        className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
      >
        engine online
      </Badge>
    );
  }
  if (kind === "connecting") {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        connecting…
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
    >
      engine offline
    </Badge>
  );
};

export const App = () => {
  const init = useInstancesStore((s) => s.init);
  const teardown = useInstancesStore((s) => s.teardown);
  const refresh = useInstancesStore((s) => s.refresh);
  const loading = useInstancesStore((s) => s.loading);
  const error = useInstancesStore((s) => s.error);
  const dismissError = useInstancesStore((s) => s.dismissError);
  const notice = useInstancesStore((s) => s.notice);
  const dismissNotice = useInstancesStore((s) => s.dismissNotice);
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

  return (
    <TooltipProvider delay={300}>
      {/* Fixed toolbar over a scrolling list: the toolbar stays put while the cards
          scroll in the ScrollArea below (h-screen column, list takes the rest). */}
      <div className="flex h-screen flex-col">
        <header className="flex shrink-0 items-center gap-3 border-b border-border px-6 py-3">
          <h1 className="text-lg font-semibold tracking-tight">compositz</h1>
          <EngineBadge kind={snapshot.kind} />
          <div className="ml-auto flex items-center gap-2">
            <ImportBar />
            <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
              <RefreshCw className={cn(loading && "animate-spin")} />
              Refresh
            </Button>
            <ThemeToggle />
          </div>
        </header>

        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto flex max-w-5xl flex-col gap-4 p-6">
            {snapshot.kind === "offline" && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-700 dark:text-amber-400">
                Docker engine unreachable — instances are listed, but actions are disabled.{" "}
                <span className="text-amber-600/80 dark:text-amber-400/70">{snapshot.error}</span>
              </div>
            )}

            {notice !== undefined && (
              <div className="flex items-start justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-700 dark:text-amber-400">
                <span>{notice}</span>
                <button
                  type="button"
                  aria-label="Dismiss notice"
                  onClick={dismissNotice}
                  className="shrink-0 opacity-70 hover:opacity-100"
                >
                  <X className="size-4" />
                </button>
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

            <InstanceList />
          </div>
        </ScrollArea>
      </div>

      <DropZone />
      <TrustDialog />
      <DeleteDialog />
      <RenameDialog />
      <GithubImportDialog />
    </TooltipProvider>
  );
};
