import { ChevronRight, Copy, Loader2, MoreVertical, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatRelativeAge } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useInstancesStore } from "@/store/instances";
import type { RowVM } from "@/store/instances";
import { ActionButton } from "./ActionButton";
import { CopyId } from "./CopyId";
import { DetailPanel } from "./DetailPanel";
import { StatusPill } from "./StatusPill";

type Props = { vm: RowVM; engineOnline: boolean };

/**
 * One instance as a collapsible card. Collapsed = identity only (name, status,
 * version + id); description and services live in the expanded body, so the
 * closed list stays scannable. The whole header toggles; the interactive
 * children (copy, actions, menu) stop propagation so they never double as a
 * toggle. The chevron is a real button carrying `aria-expanded` — the
 * keyboard-reachable way to open the card.
 */
export const InstanceCard = ({ vm, engineOnline }: Props) => {
  const { row, busy, duplicating, deleting, expanded } = vm;
  const up = useInstancesStore((s) => s.up);
  const down = useInstancesStore((s) => s.down);
  const install = useInstancesStore((s) => s.install);
  const duplicate = useInstancesStore((s) => s.duplicate);
  const requestDelete = useInstancesStore((s) => s.requestDelete);
  const requestRename = useInstancesStore((s) => s.requestRename);
  const toggleExpanded = useInstancesStore((s) => s.toggleExpanded);

  const menuBusy = duplicating || deleting;

  return (
    <section className="rounded-xl border border-border bg-card text-card-foreground">
      <div
        className="flex cursor-pointer items-center gap-3 px-4 py-3 select-none"
        onClick={() => toggleExpanded(row.instanceId)}
      >
        <Button
          size="icon-sm"
          variant="ghost"
          className="shrink-0 text-muted-foreground"
          aria-label={expanded ? "Hide details" : "Show details"}
          aria-expanded={expanded}
          onClick={(e) => {
            e.stopPropagation();
            toggleExpanded(row.instanceId);
          }}
        >
          <ChevronRight
            className={cn("transition-transform duration-150", expanded && "rotate-90")}
          />
        </Button>

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium">{row.name}</span>
            <StatusPill installed={row.installed} running={row.running} />
          </div>
          <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <span className="shrink-0">v{row.version} ·</span>
            <CopyId id={row.instanceId} className="text-muted-foreground/80" />
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          <ActionButton
            row={row}
            busy={busy}
            engineOnline={engineOnline && !deleting}
            onUp={() => void up(row.instanceId)}
            onDown={() => void down(row.instanceId)}
            onInstall={() => void install(row.instanceId)}
          />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button size="icon-sm" variant="ghost" aria-label="More actions">
                  {menuBusy ? <Loader2 className="animate-spin" /> : <MoreVertical />}
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="w-auto min-w-36">
              <DropdownMenuItem disabled={menuBusy} onClick={() => requestRename(row)}>
                <Pencil />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem disabled={menuBusy} onClick={() => void duplicate(row.instanceId)}>
                <Copy />
                Duplicate
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                disabled={deleting}
                onClick={() => requestDelete(row)}
              >
                <Trash2 />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border px-4 py-3">
          <div className="flex flex-col gap-3">
            {row.description !== "" && (
              <p className="text-sm break-words whitespace-pre-line text-muted-foreground">
                {row.description}
              </p>
            )}
            {(row.source || row.createdAt) && (
              <p className="text-xs text-muted-foreground/80">
                {row.source && (
                  <>
                    From <span className="font-mono break-all">{row.source}</span>
                  </>
                )}
                {row.source && row.createdAt && " · "}
                {row.createdAt && (
                  <span title={row.createdAt}>created {formatRelativeAge(row.createdAt)}</span>
                )}
              </p>
            )}
            <DetailPanel vm={vm} />
          </div>
        </div>
      )}
    </section>
  );
};
