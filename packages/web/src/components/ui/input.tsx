import { forwardRef, type InputHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = "text", ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        "w-full h-[var(--input-height)] px-3",
        "bg-surface-container-lowest text-on-surface",
        "border border-outline-variant rounded-[var(--radius-input)]",
        "font-body text-base placeholder:text-text-muted",
        "transition-[border-color,box-shadow] duration-normal ease-out",
        "focus-visible:outline-none focus-visible:border-primary focus-visible:shadow-ring",
        "disabled:cursor-not-allowed disabled:opacity-60",
        "aria-invalid:border-error aria-invalid:focus-visible:shadow-ring-error",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";
