"use client";

import { ShieldAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

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

  return (
    <div
      className="flex items-center justify-center gap-3 border-b border-amber-border bg-amber-light px-4 py-2 text-sm font-medium text-amber-text"
      role="alert"
      aria-live="polite"
    >
      <ShieldAlert size={16} aria-hidden="true" className="shrink-0" />
      <span>
        {t("browsingAs", { name: displayName })}
        {impersonation.reason && (
          <span className="ml-1 text-xs font-normal">— {impersonation.reason}</span>
        )}
      </span>
      {remaining && <span className="font-mono text-xs text-amber-dark">{remaining}</span>}
      <button
        type="button"
        onClick={endImpersonation}
        className="ml-2 rounded-md bg-tertiary px-3 py-1 text-xs font-semibold text-on-tertiary transition-colors duration-normal ease-out focus-visible:ring-2 focus-visible:ring-tertiary focus-visible:ring-offset-2"
      >
        {t("endSession")}
      </button>
    </div>
  );
}
