"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import {
  type ComponentPropsWithoutRef,
  type ElementRef,
  forwardRef,
  type HTMLAttributes,
} from "react";

import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogClose = DialogPrimitive.Close;

export const DialogOverlay = forwardRef<
  ElementRef<typeof DialogPrimitive.Overlay>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-[var(--z-modal)] bg-overlay",
      // ADR-035 D15 — scrim fades in with the dialog entrance (300ms
      // --ease-out via @starting-style) and lifts with the faster exit:
      // the dedicated `overlay-exit` keyframe (globals.css) over
      // --duration-exit --ease-in. A CSS *animation* (not a transition)
      // because Radix Presence only awaits animations before unmounting;
      // the entrance transition is disabled on close so the exit
      // animation owns the closed state and the two never compound. The
      // global reduced-motion block collapses both to instant final
      // state (E17).
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
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

export const DialogContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        // TOP-ANCHORED, not vertically centered: a centered overlay
        // re-centers on every content-height change, so any dialog whose
        // body grows/shrinks while open (search results, wizard steps,
        // async loads, error banners) makes the whole surface jump.
        // Anchored at a fixed 15vh, height changes only extend the
        // bottom edge and inputs never move. Static confirmation
        // surfaces that want true centering use AlertDialog — a
        // centered overlay may never contain height-dynamic content.
        "fixed left-1/2 top-[15vh] z-[var(--z-modal)] -translate-x-1/2 translate-y-0",
        "w-full max-w-lg p-6",
        "max-h-[80vh] overflow-y-auto",
        "bg-surface-container-lowest text-on-surface",
        "border border-border-brand rounded-[var(--radius-lg)]",
        "shadow-overlay",
        // ADR-035 D15 — enter: opacity 0→1 + scale(0.98)→1 over
        // --duration-slower (300ms) --ease-out via @starting-style, once
        // per open. Exit: plain fade, faster than entrance — the
        // dedicated `overlay-exit` keyframe over --duration-exit (200ms)
        // --ease-in, with the entrance transition disabled on close so
        // the exit animation owns the closed state. Radix centering rides
        // the `translate` property, so the opacity/scale motion never
        // touches it — compositor properties only (E18).
        "transition-[opacity,scale] duration-[var(--duration-slower)] ease-out",
        "starting:opacity-0 starting:scale-[0.98]",
        "data-[state=closed]:transition-none",
        "data-[state=closed]:opacity-0",
        "data-[state=closed]:animate-[overlay-exit_var(--duration-exit)_var(--ease-in)_forwards]",
        "focus:outline-none",
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close
        className={cn(
          "absolute right-4 top-4 rounded-[var(--radius-sm)] p-1",
          "text-on-surface-variant opacity-70 transition-opacity",
          "hover:opacity-100 focus-visible:outline-none focus-visible:shadow-ring",
          "disabled:pointer-events-none",
        )}
      >
        <X size={16} aria-hidden="true" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

export function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1.5 text-left mb-4", className)} {...props} />;
}
DialogHeader.displayName = "DialogHeader";

export function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex flex-col-reverse gap-2 mt-6 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  );
}
DialogFooter.displayName = "DialogFooter";

export const DialogTitle = forwardRef<
  ElementRef<typeof DialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("font-heading text-xl leading-tight text-on-surface", className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

export const DialogDescription = forwardRef<
  ElementRef<typeof DialogPrimitive.Description>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-on-surface-variant", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;
