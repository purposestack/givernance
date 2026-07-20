import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Auth card wrapper. Mirrors the marketing site's hero dashboard card
 * (givernance-website, live-dashboard.tsx): a flat surface with a teal-16%
 * hairline border (`border-border-brand`) and soft-rounded corners — and
 * deliberately NO box-shadow, so the auth screens read as a continuation of
 * the marketing hero rather than a floating elevated panel.
 *
 * ADR-035 (light touch on pre-auth surfaces): the card carries the single
 * `.reveal-item` entrance — it fades/rises once per mount, slot 0. Nothing
 * inside the card gets its own choreography (rule E19), and the shell around
 * it (logo header, waves, locale picker, footer) stays static (rule A1).
 */
export function AuthCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "reveal-item w-full max-w-[440px] rounded-2xl border border-border-brand bg-surface-container-lowest p-10",
        className,
      )}
    >
      {children}
    </div>
  );
}
