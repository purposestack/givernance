import { useTranslations } from "next-intl";
import type { ProgressSlotProps } from "../types";
import { useProgressModel } from "../use-progress-model";

/**
 * Civic Modern `Progress` — 4-cell transparency grid (raised, goal,
 * supporters, % funded). Stats foreground; the bar is secondary.
 */
export function CivicProgress({ data }: ProgressSlotProps) {
  const t = useTranslations("publicDonationPage.progress");
  const model = useProgressModel(data);
  if (!model) return null;
  const { progressPercent, raisedFormatted, goalFormatted, donorCountFormatted, ariaValueText } =
    model;

  return (
    <section
      className="civic-progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progressPercent}
      aria-valuetext={ariaValueText}
    >
      <div className="civic-progress__cell">
        <p className="civic-progress__label">{t("labels.raised")}</p>
        <p className="civic-progress__value">{raisedFormatted}</p>
      </div>
      <div className="civic-progress__cell">
        <p className="civic-progress__label">{t("labels.goal")}</p>
        <p className="civic-progress__value">{goalFormatted}</p>
      </div>
      <div className="civic-progress__cell">
        <p className="civic-progress__label">{t("labels.supporters")}</p>
        <p className="civic-progress__value">{donorCountFormatted}</p>
      </div>
      <div className="civic-progress__cell">
        <p className="civic-progress__label">{t("labels.percentFunded")}</p>
        <p className="civic-progress__value">{progressPercent} %</p>
      </div>
      <div className="civic-progress__bar" aria-hidden="true">
        <span style={{ width: `${progressPercent}%` }} />
      </div>
    </section>
  );
}
