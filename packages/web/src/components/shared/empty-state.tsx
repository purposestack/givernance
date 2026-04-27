import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center px-8 py-16 text-center", className)}>
      {Icon ? (
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary-50 text-primary">
          <Icon size={32} strokeWidth={1.5} aria-hidden="true" />
        </div>
      ) : null}
      <h2 className="mb-2 font-heading text-xl text-on-surface">{title}</h2>
      {description ? (
        <p className="mb-6 max-w-[400px] text-sm text-on-surface-variant">{description}</p>
      ) : null}
      {action ? <div>{action}</div> : null}
    </div>
  );
}
