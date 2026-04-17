"use client";

import { Check } from "lucide-react";
import { useTranslations } from "next-intl";

/**
 * 5-step wizard progress indicator.
 * Matches `.wizard-progress` + `.wizard-step` + `.wizard-step-connector` from base.css.
 */

export interface WizardProgressProps {
  /** Currently displayed step (1..5). */
  currentStep: 1 | 2 | 3 | 4 | 5;
}

type StepNum = 1 | 2 | 3 | 4 | 5;
type StepState = "completed" | "active" | "upcoming";

const STEPS: readonly StepNum[] = [1, 2, 3, 4, 5];

const DOT_CLASSES: Record<StepState, string> = {
  active: "border-primary bg-primary text-on-primary",
  completed: "border-primary-light bg-primary-light text-on-primary",
  upcoming: "border-outline-variant bg-surface-container-lowest text-text-secondary",
};

const LABEL_CLASSES: Record<StepState, string> = {
  active: "text-primary",
  completed: "text-text-secondary",
  upcoming: "text-text-secondary",
};

function stepState(step: StepNum, current: StepNum): StepState {
  if (step < current) return "completed";
  if (step === current) return "active";
  return "upcoming";
}

export function WizardProgress({ currentStep }: WizardProgressProps) {
  const t = useTranslations("onboarding.steps");

  const labels: Record<StepNum, string> = {
    1: t("organisation"),
    2: t("team"),
    3: t("data"),
    4: t("gdpr"),
    5: t("ready"),
  };

  return (
    <ol className="mb-8 flex items-center justify-center gap-2" aria-label={t("progressLabel")}>
      {STEPS.map((step, index) => {
        const state = stepState(step, currentStep);
        const isLast = index === STEPS.length - 1;
        return (
          <li key={step} className="flex items-center gap-2">
            <StepMarker
              step={step}
              state={state}
              label={labels[step]}
              srLabel={t("srLabel", {
                step,
                total: STEPS.length,
                name: labels[step],
                state: t(`state.${state}`),
              })}
            />
            {!isLast && <StepConnector completed={step < currentStep} />}
          </li>
        );
      })}
    </ol>
  );
}

interface StepMarkerProps {
  step: StepNum;
  state: StepState;
  label: string;
  srLabel: string;
}

function StepMarker({ step, state, label, srLabel }: StepMarkerProps) {
  return (
    <div className="flex items-center gap-2" aria-current={state === "active" ? "step" : undefined}>
      <div
        className={`flex h-8 w-8 items-center justify-center rounded-full border-2 text-sm font-semibold transition-all duration-normal ${DOT_CLASSES[state]}`}
        aria-hidden="true"
      >
        {state === "completed" ? <Check className="h-3.5 w-3.5" /> : step}
      </div>
      <span className={`hidden text-xs font-medium md:block ${LABEL_CLASSES[state]}`}>{label}</span>
      <span className="sr-only">{srLabel}</span>
    </div>
  );
}

function StepConnector({ completed }: { completed: boolean }) {
  return (
    <span
      className={`block h-0.5 w-6 md:w-10 ${completed ? "bg-primary-light" : "bg-outline-variant"}`}
      aria-hidden="true"
    />
  );
}
