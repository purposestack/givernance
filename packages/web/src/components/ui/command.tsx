"use client";

import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";
import {
  type ComponentPropsWithoutRef,
  type ElementRef,
  forwardRef,
  type HTMLAttributes,
} from "react";

import { cn } from "@/lib/utils";
import { Dialog, DialogContent } from "./dialog";

/**
 * ADR-035 rule D15 — overlay motion for the command palette, bound to
 * the shared motion tokens. No tw-animate plugin is installed, so the
 * `animate-in` / `fade-*` data-state classes DialogContent carries are
 * inert; these utilities are the working implementation:
 *   - Entrance: opacity 0→1 + scale 0.98→1 over --duration-slower
 *     --ease-out, driven by a transition out of `@starting-style`
 *     (Tailwind `starting:` variant) on first mount. The centring
 *     translate is untouched — transition-property is opacity/scale
 *     only, and Tailwind v4 scale/translate are independent properties.
 *   - Exit (faster, plain fade): the existing `revealIn` keyframes
 *     played in reverse over the closed-state `opacity-0` base — 200 ms,
 *     effective --ease-in per the ADR. A CSS *animation* (not a
 *     transition) because Radix only delays unmount for animations; the
 *     transition is disabled on close so the two never compound.
 *     NB: `animation-direction: reverse` also reverses the timing
 *     function, and --ease-out (0.16,1,0.3,1) is the exact bezier
 *     reverse of --ease-in (0.7,0,0.84,0) — so declaring --ease-out
 *     here yields the ADR's --ease-in curve once reversed.
 * Both collapse to instant final state under the global reduced-motion
 * block in globals.css (rule E17). Compositor properties only (E18).
 */
export const commandDialogMotion = cn(
  "scale-100 transition-[opacity,scale]",
  "duration-[var(--duration-slower)] ease-[var(--ease-out)]",
  "starting:opacity-0 starting:scale-[0.98]",
  "data-[state=closed]:transition-none data-[state=closed]:opacity-0",
  "data-[state=closed]:animate-[revealIn_200ms_var(--ease-out)_reverse]",
);

export const Command = forwardRef<
  ElementRef<typeof CommandPrimitive>,
  ComponentPropsWithoutRef<typeof CommandPrimitive>
>(({ className, ...props }, ref) => (
  <CommandPrimitive
    ref={ref}
    className={cn(
      "flex h-full w-full flex-col overflow-hidden",
      "bg-surface-container-lowest text-on-surface",
      "rounded-[var(--radius-md)]",
      className,
    )}
    {...props}
  />
));
Command.displayName = CommandPrimitive.displayName;

export function CommandDialog({ children, ...props }: ComponentPropsWithoutRef<typeof Dialog>) {
  return (
    <Dialog {...props}>
      <DialogContent className={cn("overflow-hidden p-0 shadow-overlay", commandDialogMotion)}>
        <Command className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-on-surface-variant [&_[cmdk-input]]:h-12">
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  );
}

export const CommandInput = forwardRef<
  ElementRef<typeof CommandPrimitive.Input>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Input>
>(({ className, ...props }, ref) => (
  <div className="flex items-center gap-2 border-b border-border-brand px-3" cmdk-input-wrapper="">
    <Search size={16} className="shrink-0 text-on-surface-variant opacity-60" aria-hidden="true" />
    <CommandPrimitive.Input
      ref={ref}
      className={cn(
        "flex h-11 w-full bg-transparent py-3 text-sm outline-none",
        "placeholder:text-text-muted disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  </div>
));
CommandInput.displayName = CommandPrimitive.Input.displayName;

export const CommandList = forwardRef<
  ElementRef<typeof CommandPrimitive.List>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.List
    ref={ref}
    className={cn("max-h-[300px] overflow-y-auto overflow-x-hidden", className)}
    {...props}
  />
));
CommandList.displayName = CommandPrimitive.List.displayName;

export const CommandEmpty = forwardRef<
  ElementRef<typeof CommandPrimitive.Empty>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>((props, ref) => (
  <CommandPrimitive.Empty
    ref={ref}
    className="py-6 text-center text-sm text-on-surface-variant"
    {...props}
  />
));
CommandEmpty.displayName = CommandPrimitive.Empty.displayName;

export const CommandGroup = forwardRef<
  ElementRef<typeof CommandPrimitive.Group>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Group
    ref={ref}
    className={cn(
      "overflow-hidden p-1 text-on-surface",
      "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-on-surface-variant",
      className,
    )}
    {...props}
  />
));
CommandGroup.displayName = CommandPrimitive.Group.displayName;

export const CommandSeparator = forwardRef<
  ElementRef<typeof CommandPrimitive.Separator>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Separator
    ref={ref}
    className={cn("-mx-1 h-px bg-outline-variant", className)}
    {...props}
  />
));
CommandSeparator.displayName = CommandPrimitive.Separator.displayName;

// ADR-035: the data-[selected] highlight below is deliberately
// transition-free — the roving selection must track arrow-key
// navigation instantly, with zero easing lag. Do not add a transition.
export const CommandItem = forwardRef<
  ElementRef<typeof CommandPrimitive.Item>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex cursor-default select-none items-center gap-2",
      "rounded-[var(--radius-sm)] px-2 py-1.5 text-sm outline-none",
      "data-[selected=true]:bg-surface-container data-[selected=true]:text-on-surface",
      "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
      className,
    )}
    {...props}
  />
));
CommandItem.displayName = CommandPrimitive.Item.displayName;

export function CommandShortcut({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "ml-auto text-xs tracking-widest text-on-surface-variant opacity-60",
        className,
      )}
      {...props}
    />
  );
}
CommandShortcut.displayName = "CommandShortcut";
