import { useEffect, useRef } from "react";
import { useInstancesStore, useRowVMs } from "@/store/instances";
import type { RowVM } from "@/store/instances";
import { InstanceCard } from "./InstanceCard";

/**
 * Surface the Services tab when an instance becomes ready. Readiness is only observable
 * here, from the live snapshot (the other action-driven switches are wired at their
 * sites). The first snapshot seeds the baseline WITHOUT switching (an already-ready app
 * must not steal the tab on load); an engaged user on a manually-picked non-logs tab is
 * never yanked.
 */
function useServicesTabOnReady(rows: RowVM[]): void {
  const setTab = useInstancesStore((s) => s.setTab);
  const prevReady = useRef<Record<string, boolean> | null>(null);
  useEffect(() => {
    const ready: Record<string, boolean> = {};
    for (const vm of rows) {
      ready[vm.row.instanceId] = vm.row.running && vm.row.services.some((s) => s.ready);
    }
    const prev = prevReady.current;
    prevReady.current = ready;
    if (prev === null) return; // baseline snapshot — no transitions yet
    for (const vm of rows) {
      const id = vm.row.instanceId;
      if (!ready[id] || prev[id]) continue; // only a false → true readiness transition
      const engaged = vm.expanded && vm.tab !== undefined && vm.tab !== "logs";
      if (!engaged) setTab(id, "services");
    }
  }, [rows, setTab]);
}

/** The dashboard: every stored instance as a live-merged, collapsible card. */
export const InstanceList = () => {
  const rows = useRowVMs();
  const snapshot = useInstancesStore((s) => s.snapshot);
  const ready = useInstancesStore((s) => s.ready);
  const engineOnline = snapshot.kind !== "offline";

  useServicesTabOnReady(rows);

  if (ready && rows.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-border p-12 text-center">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">No instances yet</p>
          <p className="text-sm text-muted-foreground">
            Import a recipe to create your first instance.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {rows.map((vm) => (
        <InstanceCard key={vm.row.instanceId} vm={vm} engineOnline={engineOnline} />
      ))}
    </div>
  );
};
