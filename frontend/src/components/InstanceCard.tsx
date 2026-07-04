import { ChevronRight, Copy, Loader2, MoreVertical, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Fragment } from "react";
import type { ReactNode } from "react";
import { formatLocalTimestamp, formatRelativeAge } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useInstancesStore } from "@/store/instances";
import type { RowVM } from "@/store/instances";
import { ActionButton } from "./ActionButton";
import { CopyId } from "./CopyId";
import { DetailPanel } from "./DetailPanel";
import { StatusPill } from "./StatusPill";

type Props = { vm: RowVM; engineOnline: boolean };

/**
 * Where this instance came from, on one muted line: origin source, duplicate
 * lineage, and created/updated ages (hover = the full LOCAL timestamp).
 */
const ProvenanceLine = ({ row }: { row: RowVM["row"] }) => {
  const parts: { key: string; node: ReactNode }[] = [];
  if (row.source) {
    parts.push({
      key: "source",
      node: (
        <>
          From <span className="font-mono break-all">{row.source}</span>
        </>
      ),
    });
  }
  if (row.duplicatedFrom) {
    parts.push({
      key: "dup",
      node: (
        <>
          duplicated from <span className="font-mono">{row.duplicatedFrom}</span>
        </>
      ),
    });
  }
  if (row.createdAt) {
    parts.push({
      key: "created",
      node: (
        <span title={formatLocalTimestamp(row.createdAt)}>
          created {formatRelativeAge(row.createdAt)}
        </span>
      ),
    });
  }
  if (row.updatedAt) {
    parts.push({
      key: "updated",
      node: (
        <span title={formatLocalTimestamp(row.updatedAt)}>
          updated {formatRelativeAge(row.updatedAt)}
        </span>
      ),
    });
  }
  if (parts.length === 0) return null;
  return (
    <p className="text-xs text-muted-foreground/80">
      {parts.map((part, i) => (
        <Fragment key={part.key}>
          {i > 0 && " · "}
          {part.node}
        </Fragment>
      ))}
    </p>
  );
};

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
  const requestUpdate = useInstancesStore((s) => s.requestUpdate);
  const toggleExpanded = useInstancesStore((s) => s.toggleExpanded);

  const menuBusy = duplicating || deleting;
  // In-place update needs a re-fetchable origin — only a GitHub source has one.
  const canUpdate = row.source?.startsWith("github:") ?? false;

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
              {/* No hover hint on the disabled item (Base UI swallows pointer
                  events there) — the source that explains WHY is on the card's
                  provenance line. */}
              <DropdownMenuItem
                disabled={menuBusy || !canUpdate}
                onClick={() => requestUpdate(row)}
              >
                <RefreshCw />
                Update
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
            <ProvenanceLine row={row} />
            <DetailPanel vm={vm} />
          </div>
        </div>
      )}
    </section>
  );
};
