"use client";

import { ArrowLeft, ArrowRight, CheckCircle, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { completeOnboardingAction } from "@/app/onboarding/actions";
import type { Tenant } from "@/models/tenant";

export interface StepConfirmationProps {
  tenant: Tenant | null;
  onBack: () => void;
  serverErrorKey?: string;
}

/**
 * Step 5 — Prêt (confirmation).
 * Summarises the Step 1 data and transitions the user to /dashboard via a
 * server action that marks `onboarding_completed_at`.
 */
export function StepConfirmation({ tenant, onBack, serverErrorKey }: StepConfirmationProps) {
  const t = useTranslations("onboarding.step5");
  const tStep1 = useTranslations("onboarding.step1");
  const tActions = useTranslations("onboarding.actions");
  const [isPending, startTransition] = useTransition();

  const disabled = isPending || !tenant;

  const submit = () => {
    startTransition(() => {
      void completeOnboardingAction();
    });
  };

  const countryLabel = tenant?.country ? tStep1(`countries.${tenant.country}`) : null;
  const legalTypeLabel = tenant?.legalType ? tStep1(`legalTypes.${tenant.legalType}`) : null;
  const currencyLabel = tStep1(`currencies.${tenant?.currency ?? "EUR"}`);

  return (
    <section aria-labelledby="onboarding-complete-title">
      <div className="mb-8 text-center">
        <span className="mx-auto mb-4 flex h-[72px] w-[72px] items-center justify-center rounded-full bg-primary-50 text-primary">
          <CheckCircle className="h-9 w-9" aria-hidden="true" />
        </span>
        <h1 id="onboarding-complete-title" className="mb-2 font-heading text-3xl text-text">
          {t("title")}
        </h1>
        <p className="mx-auto max-w-[480px] text-md leading-relaxed text-text-secondary">
          {tenant ? t("subtitleWithName", { name: tenant.name }) : t("subtitle")}
        </p>
      </div>

      {serverErrorKey === "complete_failed" && (
        <div
          role="alert"
          className="mb-4 flex items-start gap-3 rounded-md border border-[rgba(186,26,26,0.12)] bg-error-container p-3 text-sm text-on-error-container"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{t("errors.complete_failed")}</span>
        </div>
      )}

      <div className="rounded-card bg-surface-container-lowest p-8 shadow-card">
        <h2 className="mb-4 text-xs font-semibold uppercase tracking-wide text-text-secondary">
          {t("summaryTitle")}
        </h2>
        <dl className="space-y-3 text-sm">
          <div className="flex items-start justify-between gap-4">
            <dt className="text-text-secondary">{tStep1("nameLabel")}</dt>
            <dd className="text-right font-medium text-text">{tenant?.name ?? "—"}</dd>
          </div>
          <div className="flex items-start justify-between gap-4">
            <dt className="text-text-secondary">{tStep1("countryLabel")}</dt>
            <dd className="text-right font-medium text-text">{countryLabel ?? "—"}</dd>
          </div>
          <div className="flex items-start justify-between gap-4">
            <dt className="text-text-secondary">{tStep1("legalTypeLabel")}</dt>
            <dd className="text-right font-medium text-text">{legalTypeLabel ?? "—"}</dd>
          </div>
          <div className="flex items-start justify-between gap-4">
            <dt className="text-text-secondary">{tStep1("currencyLabel")}</dt>
            <dd className="text-right font-medium text-text">{currencyLabel}</dd>
          </div>
          {tenant?.registrationNumber && (
            <div className="flex items-start justify-between gap-4">
              <dt className="text-text-secondary">{tStep1("registrationNumberLabel")}</dt>
              <dd className="text-right font-medium text-text">{tenant.registrationNumber}</dd>
            </div>
          )}
        </dl>
      </div>

      <div className="mt-8 flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex h-[var(--btn-height-lg)] items-center gap-2 rounded-button border border-border bg-surface-container-lowest px-6 font-body text-base font-medium text-text transition-opacity duration-normal ease-out hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          {tActions("back")}
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={disabled}
          className="inline-flex h-[52px] items-center gap-2 rounded-md bg-primary px-8 font-body text-md font-semibold text-on-primary transition-opacity duration-normal ease-out hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isPending ? tActions("completing") : t("cta")}
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
