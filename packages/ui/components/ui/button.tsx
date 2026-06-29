import type { JSX } from "preact";
import { forwardRef } from "preact/compat";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils.ts";

// The canonical Shadcn Button (cva variants), Preact-adapted (`class`). This base button
// needs no React primitive — plain Preact + Tailwind — so it works without preact/compat.
export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-6",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export type ButtonProps =
  & Omit<JSX.IntrinsicElements["button"], "ref">
  & VariantProps<typeof buttonVariants>;

// forwardRef so composition wrappers (e.g. Base UI's `render={<Button/>}`) can attach
// their ref to the underlying <button> — the canonical Shadcn Button shape.
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ class: cls, variant, size, children, ...props }, ref) => (
    <button ref={ref} class={cn(buttonVariants({ variant, size }), cls as string)} {...props}>
      {children}
    </button>
  ),
);
