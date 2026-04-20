import { forwardRef, type TextareaHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, rows = 4, ...props }, ref) => (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(
        "w-full min-h-[var(--input-height)] px-3 py-2",
        "bg-surface-container-lowest text-on-surface",
        "border border-outline-variant rounded-[var(--radius-input)]",
        "font-body text-base placeholder:text-text-muted",
        "transition-[border-color,box-shadow] duration-normal ease-out",
        "focus-visible:outline-none focus-visible:border-primary focus-visible:shadow-ring",
        "disabled:cursor-not-allowed disabled:opacity-60",
        "aria-invalid:border-error aria-invalid:focus-visible:shadow-ring-error",
        "resize-y",
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";
