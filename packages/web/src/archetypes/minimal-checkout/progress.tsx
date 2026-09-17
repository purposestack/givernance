import { useTranslations } from "next-intl";
import type { ProgressSlotProps } from "../types";
import { useProgressModel } from "../use-progress-model";

export function MinimalProgress({ data }: ProgressSlotProps) {
  const t = useTranslations("publicDonationPage.progress");
  const model = useProgressModel(data);
  if (!model) return null;
  const { progressPercent, raisedFormatted, goalFormatted, ariaValueText } = model;

  return (
    <section
      className="minimal-progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progressPercent}
      aria-valuetext={ariaValueText}
    >
      <div>
        <p className="minimal-progress__label">{t("labels.raised")}</p>
        <p className="minimal-progress__amount">
          {raisedFormatted} <span>/ {goalFormatted}</span>
        </p>
      </div>
      <div className="minimal-progress__pct">{progressPercent} %</div>
      <div className="minimal-progress__bar" aria-hidden="true">
        <span style={{ width: `${progressPercent}%` }} />
      </div>
    </section>
  );
}
