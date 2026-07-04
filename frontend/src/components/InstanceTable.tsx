import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useInstancesStore, useRowVMs } from "@/store/instances";
import { InstanceRow } from "./InstanceRow";

/** The dashboard list: every stored instance as a live-merged row. */
export const InstanceTable = () => {
  const rows = useRowVMs();
  const snapshot = useInstancesStore((s) => s.snapshot);
  const ready = useInstancesStore((s) => s.ready);
  const engineOnline = snapshot.kind !== "offline";

  if (ready && rows.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-border p-12 text-center">
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
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-4">Instance</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Services</TableHead>
            <TableHead className="pr-4 text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((vm) => (
            <InstanceRow key={vm.row.instanceId} vm={vm} engineOnline={engineOnline} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
};
