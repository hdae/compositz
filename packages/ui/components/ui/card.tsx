import type { JSX } from "preact";
import { cn } from "../../lib/utils.ts";

// Canonical Shadcn Card family (Tailwind v4 source), adapted to Preact: prop name is
// `class` (not `className`) to match button.tsx and the islands' `class=` usage; the
// `data-slot` hooks and utility classes are the upstream component verbatim.

type DivProps = JSX.IntrinsicElements["div"];

export function Card({ class: cls, ...props }: DivProps) {
  return (
    <div
      data-slot="card"
      class={cn(
        "bg-card text-card-foreground flex flex-col gap-6 rounded-xl border py-6 shadow-sm",
        cls as string,
      )}
      {...props}
    />
  );
}

export function CardHeader({ class: cls, ...props }: DivProps) {
  return (
    <div
      data-slot="card-header"
      class={cn(
        "@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-1.5 px-6 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-6",
        cls as string,
      )}
      {...props}
    />
  );
}

export function CardTitle({ class: cls, ...props }: DivProps) {
  return (
    <div
      data-slot="card-title"
      class={cn("leading-none font-semibold", cls as string)}
      {...props}
    />
  );
}

export function CardDescription({ class: cls, ...props }: DivProps) {
  return (
    <div
      data-slot="card-description"
      class={cn("text-muted-foreground text-sm", cls as string)}
      {...props}
    />
  );
}

export function CardAction({ class: cls, ...props }: DivProps) {
  return (
    <div
      data-slot="card-action"
      class={cn("col-start-2 row-span-2 row-start-1 self-start justify-self-end", cls as string)}
      {...props}
    />
  );
}

export function CardContent({ class: cls, ...props }: DivProps) {
  return <div data-slot="card-content" class={cn("px-6", cls as string)} {...props} />;
}

export function CardFooter({ class: cls, ...props }: DivProps) {
  return (
    <div
      data-slot="card-footer"
      class={cn("flex items-center px-6 [.border-b]:pt-6", cls as string)}
      {...props}
    />
  );
}
