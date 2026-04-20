"use client";

import { Toaster as SonnerToaster, toast } from "sonner";

type ToasterProps = React.ComponentProps<typeof SonnerToaster>;

export function Toaster({ position = "top-right", ...props }: ToasterProps) {
  return (
    <SonnerToaster
      position={position}
      toastOptions={{
        classNames: {
          toast:
            "group toast !bg-surface-container-lowest !text-on-surface !border !border-outline-variant !rounded-[var(--radius-md)] !shadow-elevated !font-body",
          title: "!font-medium !text-on-surface",
          description: "!text-on-surface-variant",
          actionButton: "!bg-primary !text-on-primary",
          cancelButton: "!bg-surface-container !text-on-surface-variant",
          success: "!text-success-text",
          error: "!text-error",
          warning: "!text-tertiary",
          info: "!text-info-text",
        },
      }}
      {...props}
    />
  );
}

export { toast };
