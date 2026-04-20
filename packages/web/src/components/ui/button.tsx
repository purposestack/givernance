import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { type ButtonHTMLAttributes, forwardRef } from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-button)]",
    "font-body font-medium transition-opacity duration-normal ease-out",
    "focus-visible:outline-none focus-visible:shadow-ring",
    "disabled:pointer-events-none disabled:opacity-50",
  ],
  {
    variants: {
      variant: {
        primary: "bg-primary text-on-primary hover:opacity-90",
        secondary: "bg-surface-container-highest text-on-surface hover:bg-surface-dim",
        ghost:
          "bg-transparent text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface",
        destructive: "bg-error text-on-error hover:opacity-90",
      },
      size: {
        sm: "h-[var(--btn-height-sm)] px-4 text-xs",
        default: "h-[var(--btn-height-md)] px-6 text-sm",
        lg: "h-[var(--btn-height-lg)] px-8 text-base",
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
