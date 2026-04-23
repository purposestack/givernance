"use client";

import { ShieldAlert, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

export interface ProvisionalAdminInfo {
  /** ISO 8601 timestamp at which the provisional window ends. */
  provisionalUntil: string;
  /** Tenant slug, for the dispute link destination. */
  orgSlug: string;
}

interface Props {
  info: ProvisionalAdminInfo | undefined;
}

const DISMISS_STORAGE_KEY = "gv.provisional-admin-banner.dismissed-until";

/**
 * Provisional-admin amber banner (issue #109 / ADR-016 / doc 22 §3.1, §4.3).
 *
 * Shown on every authenticated page while `users.first_admin=true` and
 * `users.provisional_until > now()`. Reuses the impersonation-banner visual
 * language (amber/`tertiary` palette). Dismissible for the current browser
 * session only — returns on every new session until the grace window closes
 * on the server.
 */
export function ProvisionalAdminBanner({ info }: Props) {
  const t = useTranslations("appShell.provisionalAdmin");
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!info) return;
    try {
      const v = sessionStorage.getItem(DISMISS_STORAGE_KEY);
      if (v && v === info.provisionalUntil) {
        setDismissed(true);
      }
    } catch {
      // Private mode / storage disabled — banner stays visible, which is the
      // safe default.
    }
  }, [info]);

  const handleDismiss = useCallback(() => {
    if (!info) return;
    setDismissed(true);
    try {
      sessionStorage.setItem(DISMISS_STORAGE_KEY, info.provisionalUntil);
    } catch {
      // ignore — dismiss is UI-only and doesn't matter if it can't persist.
    }
  }, [info]);

  if (!info || dismissed) return null;

  const until = new Date(info.provisionalUntil);
  if (!Number.isFinite(until.getTime()) || until <= new Date()) return null;

  // FR: "Vous êtes l'administrateur provisoire jusqu'au <date>. Tout autre
  // membre vérifié peut contester." — matches doc 22 §3.1 copy.
  const formattedDate = new Intl.DateTimeFormat(undefined, {
    dateStyle: "long",
  }).format(until);

  return (
    <div
      className="flex flex-wrap items-center justify-center gap-3 border-b border-amber-border bg-amber-light px-4 py-2 text-sm font-medium text-amber-text"
      role="status"
      aria-live="polite"
    >
      <ShieldAlert size={16} aria-hidden="true" className="shrink-0" />
      <span className="flex-1 text-center">{t("body", { date: formattedDate })}</span>
      <a
        href={`/${info.orgSlug}/settings/team?section=provisional`}
        className="rounded-md border border-tertiary px-3 py-1 text-xs font-semibold text-tertiary transition-colors duration-normal ease-out hover:bg-tertiary hover:text-on-tertiary focus-visible:ring-2 focus-visible:ring-tertiary focus-visible:ring-offset-2"
      >
        {t("learnMore")}
      </a>
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
