import { Badge } from "@/components/ui/badge";

type Props = {
  /** Image built locally? `null` when the engine is unreachable (unknown). */
  installed: boolean | null;
  running: boolean;
};

/**
 * The derived status badge. Precedence mirrors core / the Deno StatusPill:
 * running → installed-unknown → installed → not-installed.
 */
export const StatusPill = ({ installed, running }: Props) => {
  if (running) {
    return (
      <Badge
        variant="outline"
        className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
      >
        running
      </Badge>
    );
  }
  if (installed === null) {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        unknown
      </Badge>
    );
  }
  if (installed) {
    return (
      <Badge
        variant="outline"
        className="border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400"
      >
        installed
      </Badge>
    );
  }
  return <Badge variant="secondary">not installed</Badge>;
};
