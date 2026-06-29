import type { ComponentChildren } from "preact";
import { Tooltip as Base } from "@base-ui-components/react/tooltip";
import { cn } from "../../lib/utils.ts";

// Shadcn-style Tooltip over Base UI's primitive (preact/compat). Styling is passed via
// `className` (Base UI's documented styling prop). Wrap the island subtree once in
// <TooltipProvider> for shared hover-delay grouping; each trigger composes the target
// via `render={<Button/>}`. Matches Shadcn's tooltip: dark `bg-primary` popup, px-3
// py-1.5, text-xs, plus the small caret arrow (positioned per Base UI's `data-side`).

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
            "z-50 w-fit text-balance rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground shadow-md",
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
            <div class="size-2.5 rotate-45 rounded-[2px] bg-primary" />
          </Base.Arrow>
        </Base.Popup>
      </Base.Positioner>
    </Base.Portal>
  );
}
