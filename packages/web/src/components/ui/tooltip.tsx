"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { type ComponentPropsWithoutRef, type ElementRef, forwardRef } from "react";

import { cn } from "@/lib/utils";

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export const TooltipContent = forwardRef<
  ElementRef<typeof TooltipPrimitive.Content>,
  ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-[var(--z-tooltip)] overflow-hidden",
        "px-2.5 py-1.5 text-xs",
        "bg-inverse-surface text-inverse-on-surface",
        "rounded-[var(--radius-sm)] shadow-overlay",
        // ADR-035 C13/D15 — tooltips are inspection surfaces: fast fade
        // only, no scale. Enter: opacity 0→1 over --duration-fast
        // --ease-out via @starting-style; exit: the dedicated
        // `overlay-exit` keyframe (globals.css) over --duration-fast
        // --ease-in, entrance transition disabled on close so the exit
        // animation owns the closed state. (The former `animate-in` /
        // `fade-*` classes were inert: no tw-animate plugin is
        // installed.) The global reduced-motion block collapses both to
        // instant final state (E17).
        "transition-opacity duration-[var(--duration-fast)] ease-out",
        "starting:opacity-0",
        "data-[state=closed]:transition-none",
        "data-[state=closed]:opacity-0",
        "data-[state=closed]:animate-[overlay-exit_var(--duration-fast)_var(--ease-in)_forwards]",
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;
