"use client";

import * as AvatarPrimitive from "@radix-ui/react-avatar";
import { cva, type VariantProps } from "class-variance-authority";
import { type ComponentPropsWithoutRef, type ElementRef, forwardRef } from "react";

import { cn } from "@/lib/utils";

const avatarVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-full)] font-body font-medium select-none",
  {
    variants: {
      size: {
        xs: "h-6 w-6 text-[10px]",
        sm: "h-8 w-8 text-xs",
        md: "h-10 w-10 text-sm",
        lg: "h-12 w-12 text-base",
        xl: "h-16 w-16 text-lg",
      },
      color: {
        primary: "bg-primary-fixed text-on-primary-fixed",
        secondary: "bg-secondary-fixed text-on-secondary-fixed",
        tertiary: "bg-tertiary-fixed text-on-tertiary-fixed",
        neutral: "bg-surface-container-highest text-on-surface-variant",
        error: "bg-error-container text-on-error-container",
      },
    },
    defaultVariants: {
      size: "md",
      color: "neutral",
    },
  },
);

export interface AvatarProps
  extends Omit<ComponentPropsWithoutRef<typeof AvatarPrimitive.Root>, "color">,
    VariantProps<typeof avatarVariants> {}

export const Avatar = forwardRef<ElementRef<typeof AvatarPrimitive.Root>, AvatarProps>(
  ({ className, size, color, ...props }, ref) => (
    <AvatarPrimitive.Root
      ref={ref}
      className={cn(avatarVariants({ size, color }), className)}
      {...props}
    />
  ),
);
Avatar.displayName = AvatarPrimitive.Root.displayName;

export const AvatarImage = forwardRef<
  ElementRef<typeof AvatarPrimitive.Image>,
  ComponentPropsWithoutRef<typeof AvatarPrimitive.Image>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Image
    ref={ref}
    className={cn("aspect-square h-full w-full object-cover", className)}
    {...props}
  />
));
AvatarImage.displayName = AvatarPrimitive.Image.displayName;

export const AvatarFallback = forwardRef<
  ElementRef<typeof AvatarPrimitive.Fallback>,
  ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Fallback
    ref={ref}
    className={cn("flex h-full w-full items-center justify-center", className)}
    {...props}
  />
));
AvatarFallback.displayName = AvatarPrimitive.Fallback.displayName;

export { avatarVariants };
