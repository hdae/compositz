import { Download, Loader2, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { InstanceRow } from "@/ipc/client";
import type { BusyKind } from "@/store/instances";
import { Tip } from "./Tip";

type Props = {
  row: InstanceRow;
  busy: BusyKind | undefined;
  engineOnline: boolean;
  onUp: () => void;
  onDown: () => void;
  onInstall: () => void;
};

const BUSY_LABEL: Record<BusyKind, string> = {
  starting: "Starting…",
  stopping: "Stopping…",
  installing: "Installing…",
};

/**
 * The primary per-instance action, chosen top-down (first match wins): an in-flight
 * action shows a disabled spinner; else running → Stop; else not-installed → Install;
 * else (installed / unknown) → Start. Icon-only for header uniformity — the verb lives
 * in the tooltip (and aria-label). All actions are disabled while the engine is offline.
 */
export const ActionButton = ({ row, busy, engineOnline, onUp, onDown, onInstall }: Props) => {
  if (busy) {
    return (
      <Tip label={BUSY_LABEL[busy]}>
        <Button size="icon-sm" disabled aria-label={BUSY_LABEL[busy]}>
          <Loader2 className="animate-spin" />
        </Button>
      </Tip>
    );
  }
  if (row.running) {
    return (
      <Tip label="Stop">
        <Button
          size="icon-sm"
          variant="outline"
          aria-label="Stop"
          disabled={!engineOnline}
          onClick={onDown}
        >
          <Square />
        </Button>
      </Tip>
    );
  }
  if (row.installed === false) {
    return (
      <Tip label="Install">
        <Button size="icon-sm" aria-label="Install" disabled={!engineOnline} onClick={onInstall}>
          <Download />
        </Button>
      </Tip>
    );
  }
  return (
    <Tip label="Start">
      <Button size="icon-sm" aria-label="Start" disabled={!engineOnline} onClick={onUp}>
        <Play />
      </Button>
    </Tip>
  );
};
