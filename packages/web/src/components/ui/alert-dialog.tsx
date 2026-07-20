"use client";

import * as AlertDialogPrimitive from "@radix-ui/react-dialog";
import {
  type ComponentPropsWithoutRef,
  type ElementRef,
  forwardRef,
  type HTMLAttributes,
} from "react";

import { cn } from "@/lib/utils";

export const AlertDialog = AlertDialogPrimitive.Root;
export const AlertDialogTrigger = AlertDialogPrimitive.Trigger;
export const AlertDialogPortal = AlertDialogPrimitive.Portal;
export const AlertDialogOverlay = forwardRef<
  ElementRef<typeof AlertDialogPrimitive.Overlay>,
  ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-[var(--z-modal)] bg-overlay",
      // ADR-035 D15 — mirrors DialogOverlay: scrim fades in with the
      // entrance (300ms --ease-out via @starting-style) and lifts with
      // the faster exit — the dedicated `overlay-exit` keyframe
      // (globals.css) over --duration-exit --ease-in; the entrance
      // transition is disabled on close so the exit animation owns the
      // closed state. (The former `animate-in` / `fade-*` classes were
      // inert: no tw-animate plugin is installed.)
      "transition-opacity duration-[var(--duration-slower)] ease-out",
      "starting:opacity-0",
      "data-[state=closed]:transition-none",
      "data-[state=closed]:opacity-0",
      "data-[state=closed]:animate-[overlay-exit_var(--duration-exit)_var(--ease-in)_forwards]",
      className,
    )}
    {...props}
  />
));
AlertDialogOverlay.displayName = "AlertDialogOverlay";

export const AlertDialogContent = forwardRef<
  ElementRef<typeof AlertDialogPrimitive.Content>,
  ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Content>
>(({ className, ...props }, ref) => (
  <AlertDialogPortal>
    <AlertDialogOverlay />
    <AlertDialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed left-1/2 top-1/2 z-[var(--z-modal)] -translate-x-1/2 -translate-y-1/2",
        // Bumped padding from p-6 → p-8 for breathing room around
        // the title / body / footer trio (super-admin feedback,
        // 2026-05-26 "la dialog box fait plate").
        "w-full max-w-lg p-8",
        "bg-surface-container-lowest text-on-surface",
        "border border-border-brand rounded-[var(--radius-lg)]",
        "shadow-overlay",
        // ADR-035 D15 — mirrors DialogContent: enter opacity 0→1 +
        // scale(0.98)→1 over --duration-slower --ease-out via
        // @starting-style; exit is the dedicated `overlay-exit` keyframe
        // over --duration-exit (200ms) --ease-in, entrance transition
        // disabled on close. Radix centering rides `translate`, so the
        // opacity/scale motion never touches it (E18). (The former
        // `animate-in` / `fade-*` classes were inert: no tw-animate
        // plugin is installed.)
        "transition-[opacity,scale] duration-[var(--duration-slower)] ease-out",
        "starting:opacity-0 starting:scale-[0.98]",
        "data-[state=closed]:transition-none",
        "data-[state=closed]:opacity-0",
        "data-[state=closed]:animate-[overlay-exit_var(--duration-exit)_var(--ease-in)_forwards]",
        "focus:outline-none",
        className,
      )}
      {...props}
    />
  </AlertDialogPortal>
));
AlertDialogContent.displayName = "AlertDialogContent";

export function AlertDialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  // gap-3 instead of gap-1.5 — title and description need real
  // separation; mb-6 below the header for distinct content area.
  return <div className={cn("mb-6 flex flex-col gap-3 text-left", className)} {...props} />;
}

export function AlertDialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      // mt-8 + gap-3 gives the footer real breathing room from the
      // body paragraph above (mt-6 + gap-2 felt cramped).
      className={cn("mt-8 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  );
}

export const AlertDialogTitle = forwardRef<
  ElementRef<typeof AlertDialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Title
    ref={ref}
    className={cn("font-heading text-xl leading-snug text-on-surface", className)}
    {...props}
  />
));
AlertDialogTitle.displayName = "AlertDialogTitle";

export const AlertDialogDescription = forwardRef<
  ElementRef<typeof AlertDialogPrimitive.Description>,
  ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Description
    ref={ref}
    // leading-relaxed instead of the Tailwind default — long RGPD
    // bodies read much better with extra line-height.
    className={cn("text-sm leading-relaxed text-on-surface-variant", className)}
    {...props}
  />
));
AlertDialogDescription.displayName = "AlertDialogDescription";

// Shared cancel/action styling — matches the design-system Button
// component's `default` size and shape so the two footer buttons
// look visually balanced. Without this `AlertDialogCancel` ships as
// an unstyled <button> (Radix Close), which renders as bare text
// next to a fully-styled primary CTA — the imbalance feedback was
// raised on 2026-05-26.
const dialogButtonBase = cn(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap",
  "rounded-[var(--radius-button)] font-body font-medium",
  "h-[var(--btn-height-md)] px-6 text-sm",
  "transition-colors duration-normal ease-out",
  "focus-visible:outline-none focus-visible:shadow-ring",
  "disabled:pointer-events-none disabled:opacity-60",
);

export const AlertDialogAction = forwardRef<
  ElementRef<typeof AlertDialogPrimitive.Close>,
  ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Close>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Close
    ref={ref}
    className={cn(dialogButtonBase, "bg-primary text-on-primary hover:bg-primary-hover", className)}
    {...props}
  />
));
AlertDialogAction.displayName = "AlertDialogAction";

export const AlertDialogCancel = forwardRef<
  ElementRef<typeof AlertDialogPrimitive.Close>,
  ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Close>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Close
    ref={ref}
    className={cn(
      dialogButtonBase,
      // Secondary affordance — token-filled surface so the button
      // reads as a real button (vs. the unstyled text it used to
      // render as), but visually subordinate to the primary action.
      "bg-surface-container-highest text-on-surface hover:bg-surface-dim",
      className,
    )}
    {...props}
  />
));
AlertDialogCancel.displayName = "AlertDialogCancel";
