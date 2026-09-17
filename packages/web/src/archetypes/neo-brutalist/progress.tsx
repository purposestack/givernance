import { useTranslations } from "next-intl";
import type { ProgressSlotProps } from "../types";
import { useProgressModel } from "../use-progress-model";

export function NeoBrutalistProgress({ data }: ProgressSlotProps) {
  const t = useTranslations("publicDonationPage.progress");
  const model = useProgressModel(data);
  if (!model) return null;
  const { progressPercent, raisedFormatted, goalFormatted, ariaValueText } = model;

  return (
    <section
      className="neo-progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progressPercent}
      aria-valuetext={ariaValueText}
    >
      <p className="neo-progress__amount">{raisedFormatted}</p>
      <div>
        <div className="neo-progress__bar" aria-hidden="true">
          <span style={{ width: `${progressPercent}%` }} />
        </div>
        <p className="neo-progress__meta">
          {t("meta.neo-brutalist", {
            goal: goalFormatted,
            percent: progressPercent,
            count: data.donorCount,
          })}
        </p>
      </div>
    </section>
  );
}
