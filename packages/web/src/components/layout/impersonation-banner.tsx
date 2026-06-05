"use client";

import { ShieldAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { setImpersonationActive } from "@/lib/api/client-browser";
import type { ImpersonationInfo } from "@/lib/auth";
import { getCsrfHeaderName, readCsrfTokenFromDocumentCookie } from "@/lib/auth/csrf";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

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
  const t = useTranslations("appShell.impersonation");
  const [ending, setEnding] = useState(false);

  /**
   * End the impersonation session and reload onto /login.
   *
   * Inlined here (not delegated to `useAuth().endImpersonation`) because:
   *   - `useAuth` reads the session id off `/v1/users/me`, which doesn't
   *     include `imp_session_id` — the value would always be undefined
   *     and the call would silently no-op.
   *   - The banner already has `impersonation.sessionId` via SSR props,
   *     so the SSR path is the source of truth and doesn't need a
   *     client-side round-trip to discover it.
   */
  async function onEndSession() {
    const sessionId = impersonation?.sessionId;
    if (!sessionId || ending) return;
    setEnding(true);
    try {
      const csrf = readCsrfTokenFromDocumentCookie();
      const headers: Record<string, string> = {};
      if (csrf) headers[getCsrfHeaderName()] = csrf;
      await fetch(`${API_URL}/v1/admin/impersonation/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
        credentials: "include",
        headers,
      });
    } catch {
      // Even on network error, the cookie-clear redirect below is the
      // right UX — the operator wants out of the session.
    }
    // Land back on the session list. The cookie was just cleared, so
    // SSR will see no auth → middleware redirects to /login → Keycloak
    // SSO auto-relogs the operator (their underlying Keycloak session
    // is still alive at the IdP) → land on /admin/impersonation. From
    // the operator's POV: one click, end up where they started.
    window.location.href = "/admin/impersonation";
  }

  // Initial value MUST be deterministic across SSR + client to avoid the
  // hydration mismatch React reports as "server rendered text didn't
  // match the client". The countdown was previously computed inside the
  // `useState` initializer using `Math.floor(Date.now() / 1000)`, which
  // runs on both the server (during SSR) and the client (during initial
  // hydration). Even a one-minute drift between those two moments
  // produces a different "Xh YYm" string and trips the dev warning. The
  // `useEffect` below already runs the same calculation on mount, so
  // the practical UX is unchanged: the time appears within a frame of
  // hydration completing, just rendered exclusively on the client.
  const [remaining, setRemaining] = useState<string>("");

  // Tell the browser API client whether this is an impersonation session so
  // it can recover from a mid-session token expiry: a 401 on a client-side
  // fetch then triggers a full navigation to /admin/impersonation, where the
  // proxy restores the operator's platform-admin session. Kept independent
  // of the countdown effect and above the `!impersonation` early-return so
  // the flag also clears when impersonation ends.
  useEffect(() => {
    setImpersonationActive(!!impersonation);
    return () => setImpersonationActive(false);
  }, [impersonation]);

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
    ? "flex items-center justify-center gap-3 border-b border-error-border bg-[var(--color-banner-danger-bg)] px-4 py-2 text-sm font-medium text-error-text"
    : "flex items-center justify-center gap-3 border-b border-amber-border bg-[var(--color-banner-warning-bg)] px-4 py-2 text-sm font-medium text-amber-text";
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
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={onEndSession}
        disabled={ending}
        className="ml-2"
      >
        {ending ? t("ending") : t("endSession")}
      </Button>
    </div>
  );
}
