import { forwardRef, type LabelHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  required?: boolean;
}

export const Label = forwardRef<HTMLLabelElement, LabelProps>(
  ({ className, required, children, ...props }, ref) => (
    // biome-ignore lint/a11y/noLabelWithoutControl: generic primitive — callers pass htmlFor to associate with an input
    <label
      ref={ref}
      className={cn("block text-sm font-medium text-on-surface mb-1.5", className)}
      {...props}
    >
      {children}
      {required ? (
        <span className="ml-0.5 text-error" aria-hidden="true">
          *
        </span>
      ) : null}
    </label>
  ),
);
Label.displayName = "Label";
