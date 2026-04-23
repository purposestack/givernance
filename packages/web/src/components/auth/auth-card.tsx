import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Auth card wrapper matching .auth-card from base.css:
 * max-width 440px, white background, rounded-2xl, elevated shadow, generous padding.
 */
export function AuthCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "w-full max-w-[440px] rounded-2xl bg-surface-container-lowest p-10 shadow-elevated",
        className,
      )}
    >
      {children}
    </div>
  );
}
