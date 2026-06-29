import type { ComponentChildren } from "preact";
import { Tooltip as Base } from "@base-ui-components/react/tooltip";
import { cn } from "../../lib/utils.ts";

// The canonical Shadcn Tooltip, re-backed on Base UI's primitive (the house standard is
// Base UI, not Radix — the upstream Shadcn tooltip imports `radix-ui`, which breaks under
// preact/compat; ADR-018). Classes mirror upstream verbatim: `bg-foreground text-background`,
// px-3 py-1.5, text-xs, text-balance, + the rotated-square caret. Styling via `className`
// (Base UI's documented prop); wrap the island subtree once in <TooltipProvider>.

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
            "z-50 w-fit text-balance rounded-md bg-foreground px-3 py-1.5 text-xs text-background shadow-md",
            cls,
          )}
        >
          {children}
          <Base.Arrow
            className={cn(
              "z-50 h-2.5 w-2.5",
              "data-[side=top]:-bottom-1 data-[side=bottom]:-top-1",
              "data-[side=left]:-right-1 data-[side=right]:-left-1",
            )}
          >
            <div class="size-2.5 rotate-45 rounded-[2px] bg-foreground" />
          </Base.Arrow>
        </Base.Popup>
      </Base.Positioner>
    </Base.Portal>
  );
}
