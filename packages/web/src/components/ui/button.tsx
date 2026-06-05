import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { type ButtonHTMLAttributes, forwardRef } from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-button)]",
    "font-body font-medium transition-colors duration-normal ease-out",
    "focus-visible:outline-none focus-visible:shadow-ring",
    "disabled:pointer-events-none disabled:opacity-60 disabled:contrast-more:opacity-75",
  ],
  {
    variants: {
      variant: {
        primary: "bg-primary text-on-primary hover:bg-primary-hover",
        secondary: "bg-surface-container-highest text-on-surface hover:bg-surface-dim",
        // Canonical low-emphasis *cancel / dismiss* affordance for dialogs.
        // Unlike `ghost` (fully transparent, no border — invisible on the
        // white `surface-container-lowest` a DialogContent renders on), the
        // 1px `outline-variant` border keeps it readable as a button against
        // any surface. Use this — NOT `ghost` — for the negative action in a
        // DialogFooter (Cancel / "Ne plus me demander"). Pair it with
        // `secondary` for a neutral middle action and `primary` for the
        // confirming action so the three tiers stay visually distinct.
        outline:
          "border border-border-brand bg-transparent text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface",
        ghost:
          "bg-transparent text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface",
        destructive: "bg-error text-on-error hover:bg-error-hover",
        // Inline text-link affordance — used for "Try a different email"
        // style resets that sit inside surface/error containers and
        // shouldn't carry a button background. Preserves the standard
        // `focus-visible:shadow-ring` outline so keyboard users still see
        // focus (a raw `<button>` styled with only an underline-on-focus
        // is an a11y regression flagged in PR #359 review).
        link: "bg-transparent text-primary underline-offset-2 hover:underline px-0",
      },
      size: {
        sm: "h-[var(--btn-height-sm)] px-4 text-xs",
        default: "h-[var(--btn-height-md)] px-6 text-sm",
        lg: "h-[var(--btn-height-lg)] px-8 text-base",
        // The link variant overrides padding to 0; this height stays so
        // the focus ring has a predictable shape, but most consumers
        // will combine `variant="link"` with `size="inline"` to opt out
        // of the fixed button height entirely.
        inline: "h-auto px-0 text-sm",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        {...(asChild ? {} : { type: type ?? "button" })}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { buttonVariants };
