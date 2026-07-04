import { Download, Loader2, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { InstanceRow } from "@/ipc/client";
import type { BusyKind } from "@/store/instances";

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
 * The primary per-row action, chosen top-down (first match wins), mirroring the Deno
 * ActionButton: an in-flight action shows a disabled spinner; else running → Stop;
 * else not-installed → Install; else (installed / unknown) → Start. All actions are
 * disabled while the engine is offline.
 */
export const ActionButton = ({ row, busy, engineOnline, onUp, onDown, onInstall }: Props) => {
  if (busy) {
    return (
      <Button size="sm" disabled>
        <Loader2 className="animate-spin" />
        {BUSY_LABEL[busy]}
      </Button>
    );
  }
  if (row.running) {
    return (
      <Button size="sm" variant="outline" disabled={!engineOnline} onClick={onDown}>
        <Square />
        Stop
      </Button>
    );
  }
  if (row.installed === false) {
    return (
      <Button size="sm" disabled={!engineOnline} onClick={onInstall}>
        <Download />
        Install
      </Button>
    );
  }
  return (
    <Button size="sm" disabled={!engineOnline} onClick={onUp}>
      <Play />
      Start
    </Button>
  );
};
