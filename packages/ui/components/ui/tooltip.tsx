import type { ComponentChildren } from "preact";
import { Tooltip as Base } from "@base-ui-components/react/tooltip";
import { cn } from "../../lib/utils.ts";

// Shadcn-style Tooltip over Base UI's primitive (preact/compat). Styling is passed via
// `className` (Base UI's documented styling prop). Wrap the island subtree once in
// <TooltipProvider> for shared hover-delay grouping; each trigger composes the target
// via `render={<Button/>}`. Popup state is exposed by Base UI as data-open/data-closed.

export const Tooltip = Base.Root;
export const TooltipProvider = Base.Provider;
export const TooltipTrigger = Base.Trigger;

export function TooltipContent(
  { class: cls, children, sideOffset = 6 }: {
    class?: string;
    children?: ComponentChildren;
    sideOffset?: number;
  },
) {
  return (
    <Base.Portal>
      <Base.Positioner sideOffset={sideOffset}>
        <Base.Popup
          className={cn(
            "z-50 w-fit rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground shadow-md",
            cls,
          )}
        >
          {children}
        </Base.Popup>
      </Base.Positioner>
    </Base.Portal>
  );
}
