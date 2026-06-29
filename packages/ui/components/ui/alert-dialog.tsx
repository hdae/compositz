import type { ComponentChildren } from "preact";
import { AlertDialog as Base } from "@base-ui-components/react/alert-dialog";
import { cn } from "../../lib/utils.ts";

// Shadcn-style AlertDialog over Base UI's primitive (portal + focus-trap, runs under
// preact/compat). Styling is passed via `className` — Base UI's documented styling
// prop, which it merges into each part's own element (the robust path; `class` only
// happened to work by being spread to the DOM).

export const AlertDialog = Base.Root;
export const AlertDialogTrigger = Base.Trigger;
export const AlertDialogClose = Base.Close;

export function AlertDialogContent(
  { class: cls, children }: { class?: string; children?: ComponentChildren },
) {
  return (
    <Base.Portal>
      <Base.Backdrop className="fixed inset-0 z-40 bg-black/50" />
      <Base.Popup
        className={cn(
          "fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-gray-200 bg-white p-6 shadow-xl",
          cls,
        )}
      >
        {children}
      </Base.Popup>
    </Base.Portal>
  );
}

export function AlertDialogTitle({ children }: { children?: ComponentChildren }) {
  return <Base.Title className="text-base font-semibold text-gray-900">{children}</Base.Title>;
}

export function AlertDialogDescription({ children }: { children?: ComponentChildren }) {
  return <Base.Description className="mt-2 text-sm text-gray-500">{children}</Base.Description>;
}

export function AlertDialogFooter({ children }: { children?: ComponentChildren }) {
  return <div class="mt-5 flex justify-end gap-2">{children}</div>;
}
