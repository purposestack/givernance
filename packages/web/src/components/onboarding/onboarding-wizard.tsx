"use client";

import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import type { Tenant } from "@/models/tenant";
import { StepConfirmation } from "./step-confirmation";
import { StepOrganisation } from "./step-organisation";
import { StepPlaceholder } from "./step-placeholder";
import { WizardProgress } from "./wizard-progress";

export interface OnboardingWizardProps {
  initialTenant: Tenant | null;
  /** `?error=...` query param forwarded from the server component. */
  serverErrorKey?: string;
}

type Step = 1 | 2 | 3 | 4 | 5;

/**
 * Onboarding wizard (client component).
 *
 * Holds the current step in local state. Step 1 submits to a server action
 * which persists the tenant profile; Steps 2–4 are Phase 2 placeholders;
 * Step 5 posts the completion and redirects to /dashboard.
 *
 * Entry-step rule: if a tenant exists and Step 1 is already filled in, start
 * on Step 5 so the user can immediately confirm; otherwise start on Step 1.
 */
export function OnboardingWizard({ initialTenant, serverErrorKey }: OnboardingWizardProps) {
  const t = useTranslations("onboarding");

  const hasStep1 = Boolean(
    initialTenant?.name &&
      initialTenant.country &&
      initialTenant.legalType &&
      initialTenant.currency,
  );

  const [step, setStep] = useState<Step>(hasStep1 ? 5 : 1);
  const [tenant, setTenant] = useState<Tenant | null>(initialTenant);

  const goBack = useCallback(() => setStep((s) => (s > 1 ? ((s - 1) as Step) : s)), []);
  const goForward = useCallback(() => setStep((s) => (s < 5 ? ((s + 1) as Step) : s)), []);

  const handleStep1Saved = useCallback(
    (saved: Tenant) => {
      setTenant(saved);
      goForward();
    },
    [goForward],
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-center gap-3">
        <span
          aria-hidden="true"
          className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary-50 text-primary"
        >
          <span className="text-xl font-bold">G</span>
        </span>
        <span className="font-heading text-2xl text-text">{t("brand")}</span>
      </div>

      <WizardProgress currentStep={step} />

      {step === 1 && <StepOrganisation initialTenant={tenant} onSaved={handleStep1Saved} />}
      {step === 2 && <StepPlaceholder stepKey="team" onBack={goBack} onSkip={goForward} />}
      {step === 3 && <StepPlaceholder stepKey="data" onBack={goBack} onSkip={goForward} />}
      {step === 4 && <StepPlaceholder stepKey="gdpr" onBack={goBack} onSkip={goForward} />}
      {step === 5 && (
        <StepConfirmation tenant={tenant} onBack={goBack} serverErrorKey={serverErrorKey} />
      )}
    </div>
  );
}
