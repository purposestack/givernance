"use client";

import { ArrowLeft, ArrowRight, Hourglass } from "lucide-react";
import { useTranslations } from "next-intl";

export type PlaceholderStepKey = "team" | "data" | "gdpr";

export interface StepPlaceholderProps {
  stepKey: PlaceholderStepKey;
  onBack: () => void;
  onSkip: () => void;
}

/**
 * Placeholder card for Steps 2–4 while Phase 2 work (#78) is pending.
 * Copy matches the reduced-scope note in issue #40 PR-A4.
 */
export function StepPlaceholder({ stepKey, onBack, onSkip }: StepPlaceholderProps) {
  const t = useTranslations("onboarding.placeholder");
  const tActions = useTranslations("onboarding.actions");

  return (
    <section aria-labelledby="onboarding-placeholder-title">
      <div className="mb-6 text-center">
        <h1 id="onboarding-placeholder-title" className="mb-2 font-heading text-2xl text-text">
          {t(`${stepKey}.title`)}
        </h1>
        <p className="text-sm text-text-secondary">{t(`${stepKey}.subtitle`)}</p>
      </div>

      <div className="rounded-card bg-surface-container-lowest p-8 shadow-card">
        <div className="flex flex-col items-center gap-4 text-center">
          <span
            aria-hidden="true"
            className="flex h-12 w-12 items-center justify-center rounded-full bg-primary-50 text-primary"
          >
            <Hourglass className="h-5 w-5" />
          </span>
          <span className="inline-flex items-center rounded-pill bg-surface-container px-3 py-1 text-xs font-medium uppercase tracking-wide text-text-secondary">
            {t("badge")}
          </span>
          <p className="max-w-[420px] text-sm text-text-secondary">{t("body")}</p>
          <a
            href="https://github.com/purposestack/givernance/issues/78"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium text-primary underline-offset-2 hover:underline"
          >
            {t("issueLink")}
          </a>
        </div>
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
          onClick={onSkip}
          className="inline-flex h-[var(--btn-height-lg)] items-center gap-2 rounded-button bg-primary px-6 font-body text-base font-medium text-on-primary transition-opacity duration-normal ease-out hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          {tActions("continue")}
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
