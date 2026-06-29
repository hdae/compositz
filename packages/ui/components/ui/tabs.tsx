import type { ComponentChildren } from "preact";
import { Tabs as Base } from "@base-ui-components/react/tabs";
import { cn } from "../../lib/utils.ts";

// Shadcn-style Tabs over Base UI's primitive (preact/compat). `Tabs` is the Root
// (controlled via value/defaultValue/onValueChange); a Tab and its Panel are paired by
// a shared `value`. Styling via `className`; the active tab is keyed off Base UI's
// `aria-selected` attribute. Inactive panels are unmounted by default (no keepMounted),
// which lets a Panel own a subscription (e.g. a log EventSource) tied to its visibility.

export const Tabs = Base.Root;

export function TabsList(
  { class: cls, children }: { class?: string; children?: ComponentChildren },
) {
  return (
    <Base.List
      className={cn(
        "inline-flex h-9 items-center justify-start gap-1 rounded-lg bg-muted p-1 text-muted-foreground",
        cls,
      )}
    >
      {children}
    </Base.List>
  );
}

export function TabsTrigger(
  { value, class: cls, children }: {
    value: string;
    class?: string;
    children?: ComponentChildren;
  },
) {
  return (
    <Base.Tab
      value={value}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 aria-selected:bg-background aria-selected:text-foreground aria-selected:shadow-sm",
        cls,
      )}
    >
      {children}
    </Base.Tab>
  );
}

export function TabsContent(
  { value, class: cls, children }: {
    value: string;
    class?: string;
    children?: ComponentChildren;
  },
) {
  return (
    <Base.Panel value={value} className={cn("mt-3 focus-visible:outline-none", cls)}>
      {children}
    </Base.Panel>
  );
}
