"use client";

import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import { type ComponentPropsWithoutRef, type ElementRef, forwardRef } from "react";

import { cn } from "@/lib/utils";

export const Checkbox = forwardRef<
  ElementRef<typeof CheckboxPrimitive.Root>,
  ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      "peer inline-flex h-4 w-4 shrink-0 items-center justify-center",
      "rounded-[var(--radius-sm)] border border-outline-variant bg-surface-container-lowest",
      "transition-colors duration-normal ease-out",
      "focus-visible:outline-none focus-visible:shadow-ring",
      "disabled:cursor-not-allowed disabled:opacity-50",
      "data-[state=checked]:bg-primary data-[state=checked]:border-primary data-[state=checked]:text-on-primary",
      "aria-invalid:border-error aria-invalid:focus-visible:shadow-ring-error",
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
      <Check size={12} strokeWidth={3} aria-hidden="true" />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;
