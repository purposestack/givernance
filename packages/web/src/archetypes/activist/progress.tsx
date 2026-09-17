import { useTranslations } from "next-intl";
import type { ProgressSlotProps } from "../types";
import { useProgressModel } from "../use-progress-model";

/**
 * Activist `Progress` — black counter strip with brand-coloured
 * eyebrow labels. Tabular-nums on every figure per slot contract.
 */
export function ActivistProgress({ data }: ProgressSlotProps) {
  const t = useTranslations("publicDonationPage.progress");
  const model = useProgressModel(data);
  if (!model) return null;
  const { progressPercent, raisedFormatted, goalFormatted, donorCountFormatted, ariaValueText } =
    model;

  return (
    <div
      className="activist-progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progressPercent}
      aria-valuetext={ariaValueText}
    >
      <div className="activist-progress__row">
        <div className="activist-progress__cell">
          <p className="activist-progress__label">{t("labels.raised")}</p>
          <p className="activist-progress__value">{raisedFormatted}</p>
        </div>
        <div className="activist-progress__cell">
          <p className="activist-progress__label">{t("labels.goal")}</p>
          <p className="activist-progress__value">{goalFormatted}</p>
        </div>
        <div className="activist-progress__cell">
          <p className="activist-progress__label">{t("labels.supporters")}</p>
          <p className="activist-progress__value">{donorCountFormatted}</p>
        </div>
        <div className="activist-progress__cell">
          <p className="activist-progress__label">{t("labels.percentFunded")}</p>
          <p className="activist-progress__value">{progressPercent}%</p>
        </div>
      </div>
      <div className="activist-progress__bar">
        <span style={{ width: `${progressPercent}%`, background: "var(--brand-primary)" }} />
      </div>
    </div>
  );
}
