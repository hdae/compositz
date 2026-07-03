import type { ContainerSummary } from "@/ipc";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

type ContainerListProps = {
  containers: ContainerSummary[];
  selectedId: string | undefined;
  loading: boolean;
  onSelect: (id: string) => void;
};

/** Map a Docker state string to a badge variant. */
function stateVariant(state: string): "default" | "secondary" | "destructive" | "outline" {
  switch (state) {
    case "running":
      return "default";
    case "exited":
    case "dead":
      return "destructive";
    default:
      return "secondary";
  }
}

export const ContainerList = ({
  containers,
  selectedId,
  loading,
  onSelect,
}: ContainerListProps) => {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>State</TableHead>
          <TableHead>Image</TableHead>
          <TableHead>Ports</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {containers.length === 0 ? (
          <TableRow>
            <TableCell colSpan={4} className="text-muted-foreground text-center">
              {loading ? "Loading containers…" : "No managed containers."}
            </TableCell>
          </TableRow>
        ) : (
          containers.map((container) => (
            <TableRow
              key={container.id}
              data-state={container.id === selectedId ? "selected" : undefined}
              className={cn("cursor-pointer", container.id === selectedId && "bg-muted")}
              onClick={() => onSelect(container.id)}
            >
              <TableCell className="font-medium">{container.name}</TableCell>
              <TableCell>
                <Badge variant={stateVariant(container.state)}>{container.state}</Badge>
              </TableCell>
              <TableCell className="text-muted-foreground font-mono text-xs">
                {container.image}
              </TableCell>
              <TableCell className="font-mono text-xs">
                {container.ports.length > 0 ? container.ports.join(", ") : "—"}
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
};
