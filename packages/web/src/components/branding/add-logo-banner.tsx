"use client";

import { ImagePlus, X } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { BrandingService } from "@/services/BrandingService";

interface Props {
  /** Tenant id used to scope the per-org dismissal. */
  orgId: string | undefined;
  /** Org-admin gate — non-admins can't act on this CTA, so don't show it. */
  canManageBranding: boolean;
}

const STORAGE_PREFIX = "gv.add-logo-banner.dismissed.";

/**
 * "Add your logo" amber banner — Phase 1 onboarding nudge for Epic #286.
 *
 * Renders at the top of every authenticated page until the operator either:
 * (1) uploads a logo (server returns a non-null `OrgLogo` from
 *     `GET /v1/branding/org-logo`), or
 * (2) dismisses the banner for this browser session (sessionStorage; comes
 *     back next session if still no logo, mirroring the
 *     ProvisionalAdminBanner pattern).
 *
 * Non-admins never see it: they can't act on it. Polls only on mount —
 * the LogoUploadCard owns the active polling while a real upload is in
 * flight, and a successful upload triggers a router refresh on its own.
 */
export function AddLogoBanner({ orgId, canManageBranding }: Props) {
  const t = useTranslations("appShell.addLogoBanner");
  const [shouldShow, setShouldShow] = useState(false);

  useEffect(() => {
    if (!orgId || !canManageBranding) return;
    let active = true;

    // Skip the network round-trip when the operator already dismissed it.
    try {
      if (sessionStorage.getItem(`${STORAGE_PREFIX}${orgId}`) === "1") {
        return;
      }
    } catch {
      // Private mode — fall through and check the API anyway.
    }

    (async () => {
      try {
        const logo = await BrandingService.getOrgLogo();
        if (!active) return;
        setShouldShow(logo === null);
      } catch {
        // Treat fetch failures as "no logo info" → don't push the banner up
        // on a transient error.
      }
    })();

    return () => {
      active = false;
    };
  }, [orgId, canManageBranding]);

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
