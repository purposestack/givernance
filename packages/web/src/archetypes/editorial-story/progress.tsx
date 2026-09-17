import { useTranslations } from "next-intl";
import type { ProgressSlotProps } from "../types";
import { useProgressModel } from "../use-progress-model";

export function EditorialProgress({ data }: ProgressSlotProps) {
  const t = useTranslations("publicDonationPage.progress");
  const model = useProgressModel(data);
  if (!model) return null;
  const { progressPercent, raisedFormatted, goalFormatted, ariaValueText } = model;

  return (
    <section className="editorial-progress" aria-label={t("sectionLabel")}>
      <p className="editorial-progress__amount">{raisedFormatted}</p>
      <div>
        <div
          className="editorial-progress__bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progressPercent}
          aria-valuetext={ariaValueText}
        >
          <span style={{ width: `${progressPercent}%` }} />
        </div>
        <p className="editorial-progress__meta">
          {t("meta.editorial-story", {
            goal: goalFormatted,
            percent: progressPercent,
            count: data.donorCount,
          })}
        </p>
      </div>
    </section>
  );
}
