import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The instance id, rendered as a click-to-copy control. The id is the disambiguating
 * key (two deployments of a recipe share its name), so a one-click copy is handy. Shows
 * a transient check on success; silently no-ops if the clipboard API is unavailable.
 */
export const CopyId = ({ id, className }: { id: string; className?: string }) => {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard unavailable (insecure context / denied) — leave the id visible to copy manually.
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      title={copied ? "Copied" : "Copy instance ID"}
      aria-label="Copy instance ID"
      className={cn(
        "inline-flex min-w-0 items-center gap-1 font-mono hover:text-foreground",
        className,
      )}
    >
      <span className="truncate">{id}</span>
      {copied ? (
        <Check className="size-3 shrink-0 text-emerald-500" />
      ) : (
        <Copy className="size-3 shrink-0 opacity-50" />
      )}
    </button>
  );
};
