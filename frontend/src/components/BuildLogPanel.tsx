import { useEffect, useRef } from "react";

type Props = { lines: string[] };

/** The streamed build/install output, auto-scrolled to the latest line. */
export const BuildLogPanel = ({ lines }: Props) => {
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
        <span className="text-muted-foreground">Waiting for build output…</span>
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
