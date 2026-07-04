import { useEffect, useRef } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";

type Props = { lines: string[]; emptyLabel?: string };

/**
 * A streamed log (build or runtime), auto-scrolled to the latest line. Wrapped in the
 * shared ScrollArea so the scrollbar matches the rest of the UI; the actual scrolling
 * element is the Base UI viewport (found via its data-slot — the Root only clips).
 */
export const LogView = ({ lines, emptyLabel = "Waiting for output…" }: Props) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const viewport = ref.current?.querySelector('[data-slot="scroll-area-viewport"]');
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [lines]);

  return (
    // The height cap goes on the VIEWPORT (the real scrolling element), not the Root:
    // the viewport's percentage height cannot resolve against an auto-height Root, so
    // a Root-level max-h would just overflow instead of scrolling.
    <ScrollArea
      ref={ref}
      className="rounded-md border border-border bg-muted/40 font-mono text-xs leading-relaxed [&_[data-slot=scroll-area-viewport]]:max-h-64"
    >
      <div className="p-3">
        {lines.length === 0 ? (
          <span className="text-muted-foreground">{emptyLabel}</span>
        ) : (
          lines.map((line, index) => (
            <div key={index} className="whitespace-pre-wrap">
              {line}
            </div>
          ))
        )}
      </div>
    </ScrollArea>
  );
};
