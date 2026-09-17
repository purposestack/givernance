import { useTranslations } from "next-intl";
import type { ProgressSlotProps } from "../types";
import { useProgressModel } from "../use-progress-model";

export function CalmProgress({ data }: ProgressSlotProps) {
  const t = useTranslations("publicDonationPage.progress");
  const model = useProgressModel(data);
  if (!model) return null;
  const { progressPercent, raisedFormatted, ariaValueText } = model;

  return (
    <div className="calm-progress">
      <div
        className="calm-progress__bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progressPercent}
        aria-valuetext={ariaValueText}
      >
        <span style={{ width: `${progressPercent}%` }} />
      </div>
      <p className="calm-progress__meta">
        {t.rich("meta.calm-wellness", {
          raised: raisedFormatted,
          percent: progressPercent,
          count: data.donorCount,
          strong: (chunks) => <strong>{chunks}</strong>,
        })}
      </p>
    </div>
  );
}
