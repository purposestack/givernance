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
    <div
      className={cn(
        "flex flex-col items-center px-8 py-16 text-center border border-dashed border-outline-variant/50 rounded-2xl bg-surface-container-lowest",
        className,
      )}
    >
      {Icon ? (
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary-fixed text-on-primary-fixed-variant shadow-primary-sm transition-transform hover:scale-105">
          <Icon size={32} strokeWidth={1.5} aria-hidden="true" />
        </div>
      ) : null}
      <h2 className="mb-2 font-heading text-xl text-on-surface">{title}</h2>
      {description ? (
        <p className="mb-6 max-w-[400px] text-sm text-on-surface-variant leading-relaxed">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
