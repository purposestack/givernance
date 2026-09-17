import { useTranslations } from "next-intl";
import type { ProgressSlotProps } from "../types";
import { useProgressModel } from "../use-progress-model";

/**
 * Cosmic Gradient `Progress` — glass card with a thin gradient bar
 * and tabular-nums counter. Sits below the hero in the scroll-reveal
 * layout.
 */
export function CosmicProgress({ data }: ProgressSlotProps) {
  const t = useTranslations("publicDonationPage.progress");
  const model = useProgressModel(data);
  if (!model) return null;
  const { progressPercent, raisedFormatted, goalFormatted, ariaValueText } = model;

  return (
    <section className="cosmic-progress" aria-label={t("sectionLabel")}>
      <p className="cosmic-progress__amount">{raisedFormatted}</p>
      <div>
        <div
          className="cosmic-progress__bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progressPercent}
          aria-valuetext={ariaValueText}
        >
          <span style={{ width: `${progressPercent}%` }} />
        </div>
        <p className="cosmic-progress__meta">
          {t.rich("meta.cosmic-gradient", {
            goal: goalFormatted,
            percent: progressPercent,
            count: data.donorCount,
            strong: (chunks) => <strong>{chunks}</strong>,
          })}
        </p>
      </div>
    </section>
  );
}
