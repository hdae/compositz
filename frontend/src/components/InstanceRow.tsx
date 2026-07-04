import { ChevronDown, ChevronRight, Copy, ExternalLink, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { Service } from "@/ipc/bindings";
import { useInstancesStore } from "@/store/instances";
import type { RowVM } from "@/store/instances";
import { ActionButton } from "./ActionButton";
import { BuildLogPanel } from "./BuildLogPanel";
import { CopyId } from "./CopyId";
import { StatusPill } from "./StatusPill";
import { Tip } from "./Tip";

type Props = { vm: RowVM; engineOnline: boolean };

/** The color of a service's readiness dot: ready / warming / stopped. */
function serviceState(service: Service, running: boolean): { dot: string; label: string } {
  if (service.ready) return { dot: "bg-emerald-500", label: "ready" };
  if (running) return { dot: "bg-amber-500", label: "starting…" };
  return { dot: "bg-muted-foreground/40", label: "stopped" };
}

export const InstanceRow = ({ vm, engineOnline }: Props) => {
  const { row, busy, duplicating, deleting, buildLog, expanded } = vm;
  const up = useInstancesStore((s) => s.up);
  const down = useInstancesStore((s) => s.down);
  const install = useInstancesStore((s) => s.install);
  const open = useInstancesStore((s) => s.open);
  const duplicate = useInstancesStore((s) => s.duplicate);
  const requestDelete = useInstancesStore((s) => s.requestDelete);
  const toggleExpanded = useInstancesStore((s) => s.toggleExpanded);

  const hasBuildLog = (buildLog?.length ?? 0) > 0;
  const hasDetail = row.services.length > 0 || hasBuildLog || row.description !== "";

  return (
    <>
      <TableRow>
        <TableCell>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate font-medium">{row.name}</span>
            <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              <span className="shrink-0">v{row.version} ·</span>
              <CopyId id={row.instanceId} className="text-muted-foreground/80" />
            </span>
            {row.description !== "" && (
              <span className="line-clamp-1 text-xs break-words text-muted-foreground/70">
                {row.description}
              </span>
            )}
          </div>
        </TableCell>
        <TableCell>
          <StatusPill installed={row.installed} running={row.running} />
        </TableCell>
        <TableCell>
          {row.services.length === 0 ? (
            <span className="text-xs text-muted-foreground">—</span>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {row.services.map((service) => {
                const { dot } = serviceState(service, row.running);
                return (
                  <Button
                    key={service.name}
                    size="xs"
                    variant="outline"
                    disabled={!row.running}
                    title={service.url}
                    onClick={() => void open(service.url)}
                  >
                    <ExternalLink />
                    {service.name}
                    <span className={cn("ml-1 size-1.5 rounded-full", dot)} />
                  </Button>
                );
              })}
            </div>
          )}
        </TableCell>
        <TableCell className="text-right">
          <div className="flex items-center justify-end gap-1.5">
            <ActionButton
              row={row}
              busy={busy}
              engineOnline={engineOnline && !deleting}
              onUp={() => void up(row.instanceId)}
              onDown={() => void down(row.instanceId)}
              onInstall={() => void install(row.instanceId)}
            />
            <Tip label="Duplicate (same settings, new ports, no data)">
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Duplicate"
                disabled={duplicating || deleting}
                onClick={() => void duplicate(row.instanceId)}
              >
                {duplicating ? <Loader2 className="animate-spin" /> : <Copy />}
              </Button>
            </Tip>
            <Tip label="Delete">
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Delete"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={deleting}
                onClick={() => requestDelete(row)}
              >
                {deleting ? <Loader2 className="animate-spin" /> : <Trash2 />}
              </Button>
            </Tip>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={expanded ? "Hide details" : "Show details"}
              aria-expanded={expanded}
              disabled={!hasDetail}
              onClick={() => toggleExpanded(row.instanceId)}
            >
              {expanded ? <ChevronDown /> : <ChevronRight />}
            </Button>
          </div>
        </TableCell>
      </TableRow>

      {expanded && (
        <TableRow>
          <TableCell colSpan={4} className="bg-muted/30 whitespace-normal">
            <div className="flex flex-col gap-3 py-1">
              {row.description !== "" && (
                <p className="text-sm break-words text-muted-foreground">{row.description}</p>
              )}
              {hasBuildLog && <BuildLogPanel lines={buildLog ?? []} />}
              {row.services.length > 0 && (
                <div className="flex flex-col gap-1.5 text-sm">
                  {row.services.map((service) => {
                    const { dot, label } = serviceState(service, row.running);
                    return (
                      <div key={service.name} className="flex items-center gap-2">
                        <span className={cn("size-2 rounded-full", dot)} />
                        <span className="font-medium">{service.name}</span>
                        <span className="text-muted-foreground">{service.url}</span>
                        <span className="text-xs text-muted-foreground">{label}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
};
