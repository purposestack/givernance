"use client";

import { ShieldAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import type { ImpersonationInfo } from "@/lib/auth";
import { useAuth } from "@/lib/auth";

interface ImpersonationBannerProps {
  impersonation: ImpersonationInfo | undefined;
  userName: string | undefined;
}

/** Format remaining seconds as "Xh XXm" or "XXm" or "< 1m". */
function formatRemaining(seconds: number, expiredLabel: string, lessThanMinLabel: string): string {
  if (seconds <= 0) return expiredLabel;
  if (seconds < 60) return lessThanMinLabel;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m.toString().padStart(2, "0")}m`;
  return `${m}m`;
}

/**
 * Impersonation amber banner — rendered server-side from JWT claims,
 * hydrated client-side for countdown and end-session action.
 */
export function ImpersonationBanner({ impersonation, userName }: ImpersonationBannerProps) {
  const { endImpersonation } = useAuth();
  const t = useTranslations("appShell.impersonation");

  const [remaining, setRemaining] = useState<string>(() => {
    if (!impersonation?.expiresAt) return "";
    return formatRemaining(
      impersonation.expiresAt - Math.floor(Date.now() / 1000),
      t("expired"),
      t("lessThanMinute"),
    );
  });

  useEffect(() => {
    if (!impersonation?.expiresAt) return;

    function tick() {
      const secs = (impersonation?.expiresAt ?? 0) - Math.floor(Date.now() / 1000);
      setRemaining(formatRemaining(secs, t("expired"), t("lessThanMinute")));
    }

    tick();
    const interval = setInterval(tick, 30_000);
    return () => clearInterval(interval);
  }, [impersonation?.expiresAt, t]);

  if (!impersonation) return null;

  const displayName = userName ?? t("fallbackUser");
  // Issue #24 — visually distinguish the two modes. Delegation uses the
  // existing amber palette ("you have extra power, be careful"); pure
  // impersonation uses a heavier red to make it obvious that writes are
  // blocked and the operator is in observation mode. Falls back to amber
  // for legacy single-mode tokens that don't carry `mode`.
  const isPure = impersonation.mode === "impersonation";
  const containerClass = isPure
    ? "flex items-center justify-center gap-3 border-b border-error-border bg-error-light px-4 py-2 text-sm font-medium text-error-text"
    : "flex items-center justify-center gap-3 border-b border-amber-border bg-amber-light px-4 py-2 text-sm font-medium text-amber-text";
  const badgeClass = isPure
    ? "rounded bg-error-text/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-error-text"
    : "rounded bg-amber-dark/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-dark";
  const badgeText = isPure ? t("modeBadgeImpersonation") : t("modeBadgeDelegation");
  const labelKey = isPure ? "impersonationLabel" : "delegationLabel";

  return (
    <div
      className={containerClass}
      role="alert"
      aria-live="polite"
      data-impersonation-mode={impersonation.mode}
    >
      <ShieldAlert size={16} aria-hidden="true" className="shrink-0" />
      <span className={badgeClass}>{badgeText}</span>
      <span>
        {t(labelKey, { name: displayName })}
        {impersonation.reason && (
          <span className="ml-1 text-xs font-normal">— {impersonation.reason}</span>
        )}
      </span>
      {remaining && <span className="font-mono text-xs">{remaining}</span>}
      <Button type="button" size="sm" variant="ghost" onClick={endImpersonation} className="ml-2">
        {t("endSession")}
      </Button>
    </div>
  );
}
