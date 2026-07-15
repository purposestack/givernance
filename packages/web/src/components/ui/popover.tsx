"use client";

import * as PopoverPrimitive from "@radix-ui/react-popover";
import { type ComponentPropsWithoutRef, type ElementRef, forwardRef } from "react";

import { cn } from "@/lib/utils";

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

export const PopoverContent = forwardRef<
  ElementRef<typeof PopoverPrimitive.Content>,
  ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "center", sideOffset = 4, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        "z-[var(--z-popover)] w-72 p-4",
        "bg-surface-container-lowest text-on-surface",
        "border border-border-brand rounded-[var(--radius-md)]",
        "shadow-overlay outline-none",
        // ADR-035 D15 — enter: fade + slight scale from the trigger-side
        // origin over --duration-normal --ease-out via @starting-style,
        // once per open. Exit: faster plain fade (--duration-fast
        // --ease-in) — the shared `cascade-in` keyframe played in reverse
        // against the closed-state opacity gives Radix Presence a real
        // animation to await before unmounting. Compositor properties
        // only (E18); the global reduced-motion block collapses both to
        // instant final state (E17).
        "origin-[var(--radix-popover-content-transform-origin)]",
        "transition-[opacity,scale] duration-[var(--duration-normal)] ease-out",
        "starting:opacity-0 starting:scale-[0.98]",
        "data-[state=closed]:opacity-0",
        "data-[state=closed]:animate-[cascade-in_var(--duration-fast)_var(--ease-in)_reverse_forwards]",
        className,
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;
