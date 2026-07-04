import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { Service } from "@/ipc/bindings";
import { useInstancesStore } from "@/store/instances";
import type { RowVM } from "@/store/instances";
import { ActionButton } from "./ActionButton";
import { BuildLogPanel } from "./BuildLogPanel";
import { StatusPill } from "./StatusPill";

type Props = { vm: RowVM; engineOnline: boolean };

/** The color of a service's readiness dot: ready / warming / stopped. */
function serviceState(service: Service, running: boolean): { dot: string; label: string } {
  if (service.ready) return { dot: "bg-emerald-500", label: "ready" };
  if (running) return { dot: "bg-amber-500", label: "starting…" };
  return { dot: "bg-muted-foreground/40", label: "stopped" };
}

export const InstanceRow = ({ vm, engineOnline }: Props) => {
  const { row, busy, buildLog, expanded } = vm;
  const up = useInstancesStore((s) => s.up);
  const down = useInstancesStore((s) => s.down);
  const install = useInstancesStore((s) => s.install);
  const open = useInstancesStore((s) => s.open);
  const toggleExpanded = useInstancesStore((s) => s.toggleExpanded);

  const hasBuildLog = (buildLog?.length ?? 0) > 0;
  const hasDetail = row.services.length > 0 || hasBuildLog || row.description !== "";

  return (
    <>
      <TableRow>
        <TableCell>
          <div className="flex flex-col">
            <span className="font-medium">{row.name}</span>
            <span className="text-xs text-muted-foreground">
              {row.appId} · v{row.version}
            </span>
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
          <div className="flex items-center justify-end gap-2">
            <ActionButton
              row={row}
              busy={busy}
              engineOnline={engineOnline}
              onUp={() => void up(row.instanceId)}
              onDown={() => void down(row.instanceId)}
              onInstall={() => void install(row.instanceId)}
            />
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
          <TableCell colSpan={4} className="bg-muted/30">
            <div className="flex flex-col gap-3 py-1">
              {row.description !== "" && (
                <p className="text-sm text-muted-foreground">{row.description}</p>
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
