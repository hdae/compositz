import { useEffect, useRef } from "react";

type Props = { lines: string[]; emptyLabel?: string };

/** A streamed log (build or runtime), auto-scrolled to the latest line. */
export const LogView = ({ lines, emptyLabel = "Waiting for output…" }: Props) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div
      ref={ref}
      className="max-h-64 overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed"
    >
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
  );
};
