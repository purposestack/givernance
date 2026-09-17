import { Unlink } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { ErrorPageShell } from "@/components/error-page-shell";

/**
 * Donor-facing 404 for `/p/[id]` — an unpublished campaign, a mistyped
 * link, or a QR code from an old letter (issue #615).
 *
 * Scoped to this segment on purpose: `notFound()` thrown by the page
 * resolves to the nearest `not-found.tsx`, which used to be the root one —
 * an OPERATOR page ("Search in Givernance", "Back to dashboard" → `/login`).
 * A donor has no account and no dashboard, so this page offers neither:
 * it says what happened and whom to ask.
 */
export default async function PublicCampaignNotFound() {
  const t = await getTranslations("publicDonationPage.notFound");

  return (
    <main id="main-content">
      <ErrorPageShell>
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-surface-container">
          <Unlink size={28} aria-hidden="true" className="text-on-surface-variant" />
        </div>
        <p className="mb-3 font-mono text-sm font-semibold uppercase tracking-wider text-primary">
          {t("label")}
        </p>
        <h1 className="mb-4 font-heading text-3xl font-normal leading-tight text-text">
          {t("title")}
        </h1>
        <p className="mx-auto mb-4 max-w-[420px] text-sm leading-relaxed text-text-secondary">
          {t("description")}
        </p>
        <p className="mx-auto max-w-[420px] text-sm leading-relaxed text-text-secondary">
          {t("hint")}
        </p>
      </ErrorPageShell>
    </main>
  );
}
