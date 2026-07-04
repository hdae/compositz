import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Wrap an icon-only control in a tooltip. The trigger renders a `<span>` wrapping the
 * control (not the control itself) so the tooltip still appears while the control is
 * disabled — a native disabled `<button>` dispatches no hover events, and the
 * busy/offline states are exactly when the label is most useful.
 */
export const Tip = ({ label, children }: { label: string; children: ReactNode }) => (
  <Tooltip>
    <TooltipTrigger render={<span className="inline-flex">{children}</span>} />
    <TooltipContent>{label}</TooltipContent>
  </Tooltip>
);
