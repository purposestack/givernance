import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface FilterBarProps extends HTMLAttributes<HTMLDivElement> {
  search?: ReactNode;
  filters?: ReactNode;
  actions?: ReactNode;
}

export function FilterBar({
  search,
  filters,
  actions,
  className,
  children,
  ...props
}: FilterBarProps) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-3",
        "bg-surface-container-lowest border border-outline-variant rounded-[var(--radius-md)]",
        "px-4 py-3",
        className,
      )}
      {...props}
    >
      {search ? <div className="flex-1 min-w-[200px] max-w-md">{search}</div> : null}
      {filters ? <div className="flex flex-wrap items-center gap-2">{filters}</div> : null}
      {children}
      {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
