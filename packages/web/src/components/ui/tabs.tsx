"use client";

import * as TabsPrimitive from "@radix-ui/react-tabs";
import { type ComponentPropsWithoutRef, type ElementRef, forwardRef } from "react";

import { cn } from "@/lib/utils";

export const Tabs = TabsPrimitive.Root;

export const TabsList = forwardRef<
  ElementRef<typeof TabsPrimitive.List>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      "inline-flex items-center gap-1 p-1",
      "bg-surface-container-low text-on-surface-variant",
      "rounded-[var(--radius-md)]",
      className,
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

export const TabsTrigger = forwardRef<
  ElementRef<typeof TabsPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "inline-flex items-center justify-center whitespace-nowrap",
      "px-3 py-1.5 text-sm font-medium",
      "rounded-[var(--radius-sm)] transition-colors duration-normal ease-out",
      "focus-visible:outline-none focus-visible:shadow-ring",
      "disabled:pointer-events-none disabled:opacity-50",
      "data-[state=active]:bg-surface-container-lowest data-[state=active]:text-on-surface data-[state=active]:shadow-xs",
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

export const TabsContent = forwardRef<
  ElementRef<typeof TabsPrimitive.Content>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn("mt-4 focus-visible:outline-none focus-visible:shadow-ring", className)}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;
