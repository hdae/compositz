import { useEffect, useRef } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";

type StreamPaneProps = {
  title: string;
  lines: string[];
  emptyHint: string;
};

/**
 * A scrolling, monospaced view of streamed lines that sticks to the bottom as
 * new lines arrive (log/terminal semantics).
 */
export const StreamPane = ({ title, lines, emptyHint }: StreamPaneProps) => {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [lines]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="text-muted-foreground mb-2 text-sm font-semibold">{title}</div>
      <ScrollArea className="border-border bg-muted/30 min-h-0 flex-1 rounded-md border">
        <div className="p-3 font-mono text-xs leading-relaxed">
          {lines.length === 0 ? (
            <span className="text-muted-foreground">{emptyHint}</span>
          ) : (
            lines.map((line, index) => (
              // Streamed lines have no stable id; index is the correct key for
              // an append-only, bounded log buffer.
              // eslint-disable-next-line react/no-array-index-key
              <div key={index} className="whitespace-pre-wrap">
                {line}
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>
    </div>
  );
};
