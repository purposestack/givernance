"use client";

import { CloudOff } from "lucide-react";
import { useTranslations } from "next-intl";

import { ErrorPageShell } from "@/components/error-page-shell";
import { PrimaryButton } from "@/components/primary-button";

/**
 * Donor-facing error boundary for `/p/[id]` (issue #615). Without it a
 * failed render falls through to the root `error.tsx`, whose footer sends
 * the visitor "back to the dashboard" — i.e. to an operator login page.
 *
 * The copy deliberately does NOT claim "nothing was charged": this
 * boundary also catches a client-side crash AFTER a payment was confirmed,
 * so it tells the donor to check for a confirmation email before giving
 * again instead.
 */
export default function PublicCampaignError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("publicDonationPage.error");

  return (
    <main id="main-content">
      <ErrorPageShell>
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-surface-container">
          <CloudOff size={28} aria-hidden="true" className="text-on-surface-variant" />
        </div>
        <h1 className="mb-4 font-heading text-3xl font-normal leading-tight text-text">
          {t("title")}
        </h1>
        <p className="mx-auto mb-6 max-w-[420px] text-sm leading-relaxed text-text-secondary">
          {t("description")}
        </p>
        {error.digest ? (
          <p className="mb-6 font-mono text-xs tracking-wide text-text-muted">
            {t("errorId", { digest: error.digest })}
          </p>
        ) : null}
        <PrimaryButton type="button" onClick={reset}>
          {t("retry")}
        </PrimaryButton>
      </ErrorPageShell>
    </main>
  );
}
