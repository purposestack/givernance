import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Auth card wrapper. Mirrors the marketing site's hero dashboard card
 * (givernance-website, live-dashboard.tsx): a flat surface with a teal-16%
 * hairline border (`border-border-brand`) and soft-rounded corners — and
 * deliberately NO box-shadow, so the auth screens read as a continuation of
 * the marketing hero rather than a floating elevated panel.
 */
export function AuthCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "w-full max-w-[440px] rounded-2xl border border-border-brand bg-surface-container-lowest p-10",
        className,
      )}
    >
      {children}
    </div>
  );
}
