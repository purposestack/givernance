"use client";

import { ImagePlus, X } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import type { OrgLogo } from "@/models/branding";

interface Props {
  /** Tenant id used to scope the per-org dismissal. */
  orgId: string | undefined;
  /** Org-admin gate — non-admins can't act on this CTA, so don't show it. */
  canManageBranding: boolean;
  /**
   * Server-resolved org logo (Epic #286 / PR #287 review, major 4).
   * Replaces the per-mount fetch the banner used to do — `null` here
   * means "no logo configured", which is exactly when the banner should
   * show. The LogoUploadCard owns the active polling during an upload
   * and a successful upload triggers a Next router refresh that flows
   * the new server-side logo back through this prop.
   */
  orgLogo?: OrgLogo | null;
}

const STORAGE_PREFIX = "gv.add-logo-banner.dismissed.";

/**
 * "Add your logo" amber banner — Phase 1 onboarding nudge for Epic #286.
 *
 * Renders at the top of every authenticated page until the operator either:
 * (1) uploads a logo (server-rendered `OrgLogo` is non-null), or
 * (2) dismisses the banner for this browser session (sessionStorage; comes
 *     back next session if still no logo, mirroring the
 *     ProvisionalAdminBanner pattern).
 *
 * Non-admins never see it: they can't act on it. The fetch hop the banner
 * used to do on mount has been hoisted into `(app)/layout.tsx` (PR #287
 * review, major 4) — no more 1 GET / nav, no flash.
 */
export function AddLogoBanner({ orgId, canManageBranding, orgLogo = null }: Props) {
  const t = useTranslations("appShell.addLogoBanner");
  const [shouldShow, setShouldShow] = useState(false);

  useEffect(() => {
    if (!orgId || !canManageBranding) return;

    // Skip when the operator already dismissed for this session.
    try {
      if (sessionStorage.getItem(`${STORAGE_PREFIX}${orgId}`) === "1") {
        setShouldShow(false);
        return;
      }
    } catch {
      // Private mode — fall through; show iff the server says no logo.
    }

    setShouldShow(orgLogo === null);
  }, [orgId, canManageBranding, orgLogo]);

  const handleDismiss = useCallback(() => {
    if (!orgId) return;
    setShouldShow(false);
    try {
      sessionStorage.setItem(`${STORAGE_PREFIX}${orgId}`, "1");
    } catch {
      // ignore — UI-only.
    }
  }, [orgId]);

  if (!shouldShow) return null;

  return (
    <div
      className="flex flex-wrap items-center justify-center gap-3 border-b border-amber-border bg-amber-light px-4 py-2 text-sm font-medium text-amber-text"
      role="status"
      aria-live="polite"
    >
      <ImagePlus size={16} aria-hidden="true" className="shrink-0" />
      <span className="flex-1 text-center">{t("body")}</span>
      <Link
        href="/settings#branding"
        className="rounded-md border border-tertiary px-3 py-1 text-xs font-semibold text-tertiary transition-colors duration-normal ease-out hover:bg-tertiary hover:text-on-tertiary focus-visible:ring-2 focus-visible:ring-tertiary focus-visible:ring-offset-2"
      >
        {t("cta")}
      </Link>
      <button
        type="button"
        onClick={handleDismiss}
        aria-label={t("dismiss")}
        className="flex h-7 w-7 items-center justify-center rounded-md text-amber-text transition-colors duration-normal ease-out hover:bg-amber-border/40 focus-visible:ring-2 focus-visible:ring-tertiary"
      >
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
