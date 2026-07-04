import { useEffect, useState } from "react";
import { streamLogs } from "@/ipc/client";
import type { Subscription } from "@/ipc/client";
import { LogView } from "./LogView";

/**
 * Streams a running container's logs while mounted. Base UI unmounts an inactive tab
 * panel, so opening the Runtime tab opens the stream and leaving it (or collapsing the
 * row) closes it. The async subscribe is guarded so a StrictMode throwaway mount that
 * resolves after cleanup unsubscribes itself instead of leaking a pump.
 */
export const RuntimeLog = ({ instanceId, running }: { instanceId: string; running: boolean }) => {
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    if (!running) return;
    setLines([]);
    let cancelled = false;
    let sub: Subscription | undefined;

    void streamLogs(instanceId, (event) => {
      if (cancelled) return;
      if (event.type === "log") setLines((l) => [...l, event.line]);
      else if (event.type === "error") setLines((l) => [...l, `\n[log error: ${event.error}]`]);
      // "end" leaves the accumulated lines in view.
    })
      .then((subscription) => {
        if (cancelled) {
          void subscription.unsubscribe();
          return;
        }
        sub = subscription;
      })
      .catch((error) => {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error);
          setLines((l) => [...l, `\n[log error: ${message}]`]);
        }
      });

    return () => {
      cancelled = true;
      if (sub) void sub.unsubscribe();
    };
  }, [instanceId, running]);

  if (!running) return <p className="text-sm text-muted-foreground">Not running.</p>;
  return <LogView lines={lines} emptyLabel="Waiting for log output…" />;
};
