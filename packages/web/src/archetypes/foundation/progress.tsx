import { useTranslations } from "next-intl";
import { formatCurrency } from "@/lib/format";
import type { ProgressSlotProps } from "../types";

/**
 * Foundation `Progress` slot — inline below hero. Shows raised /
 * goal in tabular-nums (slot-contract requirement) + a horizontal
 * progress bar. Mirrors the production `<Progress>` block.
 */
export function FoundationProgress({ data }: ProgressSlotProps) {
  const t = useTranslations("publicDonationPage");
  const hasGoal = data.goalAmountCents !== null && data.goalAmountCents > 0;
  const goalCents = data.goalAmountCents ?? 0;
  const progressPercent =
    hasGoal && goalCents > 0 ? Math.min(100, Math.round((data.raisedCents / goalCents) * 100)) : 0;

  if (!hasGoal || data.raisedCents === 0) return null;

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
        <span className="font-semibold">{formatCurrency(data.raisedCents, "en")}</span>
        <span className="ml-1 text-sm font-normal text-on-surface-variant">
          {t("metrics.goalSuffix")} {formatCurrency(goalCents, "en")}
        </span>
      </p>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progressPercent}
        aria-valuetext={`${progressPercent} percent funded`}
        aria-label={t("metrics.raised")}
        className="mt-3 h-2.5 overflow-hidden rounded-full bg-surface-container"
      >
        <div
          className="h-full rounded-full transition-[width] duration-slow"
          style={{ width: `${progressPercent}%`, backgroundColor: data.colorPrimary }}
        />
      </div>
    </div>
  );
}
