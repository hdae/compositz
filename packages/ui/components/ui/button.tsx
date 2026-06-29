import type { JSX } from "preact";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils.ts";

// Shadcn-style Button (cva variants). This base button needs no React primitive —
// it is plain Preact + Tailwind, so it works without the preact/compat layer.
export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-gray-900 text-gray-50 hover:bg-gray-900/90",
        destructive: "bg-red-600 text-gray-50 hover:bg-red-600/90",
        outline: "border border-gray-300 bg-transparent hover:bg-gray-100",
        secondary: "bg-gray-100 text-gray-900 hover:bg-gray-200",
        ghost: "hover:bg-gray-100",
        link: "text-blue-600 underline-offset-4 hover:underline",
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
  & JSX.IntrinsicElements["button"]
  & VariantProps<typeof buttonVariants>;

export function Button({ class: cls, variant, size, children, ...props }: ButtonProps) {
  return (
    <button class={cn(buttonVariants({ variant, size }), cls as string)} {...props}>
      {children}
    </button>
  );
}
