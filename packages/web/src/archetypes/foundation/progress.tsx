"use client";

import { useTranslations } from "next-intl";
import { formatCurrency } from "@/lib/format";
import type { ProgressSlotProps } from "../types";
import { useProgressModel } from "../use-progress-model";

/**
 * Foundation `Progress` slot — inline below hero. Shows the campaign
 * goal as a target whenever one is set (raised total, goal, progress
 * bar). On a fresh campaign with no donations yet, the bar is empty
 * (0%) but the goal stays visible so the donor knows the target.
 * Returns `null` only when no goal has been configured for the
 * campaign — preserves the trust-strip fallback in that branch.
 */
export function FoundationProgress({ data }: ProgressSlotProps) {
  const t = useTranslations("publicDonationPage");
  const model = useProgressModel(data);
  if (!model) return null;
  const { goalCents, progressPercent, ariaValueText } = model;

  return (
    <div className="border-t border-outline-variant px-5 py-5 sm:px-8 sm:py-6 lg:px-10 lg:py-8">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-on-surface-variant">
          {t("metrics.raised")}
        </p>
      </div>
      <p
        className="mt-2 font-heading text-2xl text-on-surface sm:text-3xl"
        style={{ fontVariantNumeric: "tabular-nums lining-nums" }}
      >
        <span className="font-semibold">{formatCurrency(data.raisedCents, data.locale, data.defaultCurrency)}</span>
        <span className="ml-1 text-sm font-normal text-on-surface-variant">
          {t("metrics.goalSuffix")} {formatCurrency(goalCents, data.locale, data.defaultCurrency)}
        </span>
      </p>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progressPercent}
        aria-valuetext={ariaValueText}
        aria-label={t("metrics.raised")}
        className="mt-3 h-2.5 overflow-hidden rounded-full bg-surface-container"
      >
        <div
          className="h-full rounded-full transition-[width] duration-slow"
          style={{ width: `${progressPercent}%`, background: "var(--brand-primary)" }}
        />
      </div>
    </div>
  );
}
