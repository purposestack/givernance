import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  [
    "inline-flex items-center gap-1 whitespace-nowrap",
    "font-mono text-xs font-bold leading-[1.4]",
    "px-2 py-[2px]",
  ],
  {
    variants: {
      variant: {
        success: "bg-primary-50 text-primary",
        warning: "bg-warning-light text-warning-text",
        error: "bg-error-container text-on-error-container",
        info: "bg-sky-50 text-sky-text",
        neutral: "bg-surface-container-highest text-on-surface-variant",
      },
      shape: {
        pill: "rounded-[var(--radius-pill)]",
        square: "rounded-[var(--radius-sm)]",
      },
    },
    defaultVariants: {
      variant: "neutral",
      shape: "pill",
    },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant, shape, ...props }, ref) => (
    <span ref={ref} className={cn(badgeVariants({ variant, shape }), className)} {...props} />
  ),
);
Badge.displayName = "Badge";

export { badgeVariants };
