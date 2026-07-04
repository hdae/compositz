import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Service } from "@/ipc/client";
import { useInstancesStore } from "@/store/instances";

/** A service's status badge — listed from the definition, so it shows even when stopped. */
function badgeOf(service: Service, running: boolean): { label: string; cls: string } {
  if (!running) return { label: "stopped", cls: "bg-muted text-muted-foreground" };
  if (service.ready) {
    return { label: "ready", cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" };
  }
  return { label: "starting…", cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400" };
}

/**
 * The declared web endpoints, always listed from the definition (so they show before
 * start). Open is active only once the live binding is confirmed (ready) and opens in
 * the OS default browser (the webview can't host the app itself).
 */
export const ServicesList = ({ services, running }: { services: Service[]; running: boolean }) => {
  const open = useInstancesStore((s) => s.open);

  if (services.length === 0) {
    return <p className="text-sm text-muted-foreground">No web UI ports declared.</p>;
  }

  return (
    <ul className="flex flex-col gap-2">
      {services.map((service) => {
        const badge = badgeOf(service, running);
        const openable = running && service.ready;
        return (
          <li
            key={service.name}
            className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{service.name}</span>
                <span className="font-mono text-xs text-muted-foreground">:{service.port}</span>
                <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", badge.cls)}>
                  {badge.label}
                </span>
              </div>
              {service.description !== undefined && service.description !== null && (
                <p className="truncate text-xs text-muted-foreground">{service.description}</p>
              )}
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={!openable}
              title={service.url}
              onClick={() => void open(service.url)}
            >
              <ExternalLink />
              Open
            </Button>
          </li>
        );
      })}
    </ul>
  );
};
