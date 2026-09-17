import { useTranslations } from "next-intl";
import type { ProgressSlotProps } from "../types";
import { useProgressModel } from "../use-progress-model";

export function RetroProgress({ data }: ProgressSlotProps) {
  const t = useTranslations("publicDonationPage.progress");
  const model = useProgressModel(data);
  if (!model) return null;
  const { progressPercent, raisedFormatted, goalFormatted, ariaValueText } = model;

  return (
    <section
      className="retro-progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progressPercent}
      aria-valuetext={ariaValueText}
    >
      <p className="retro-progress__amount">{raisedFormatted}</p>
      <div>
        <div className="retro-progress__bar" aria-hidden="true">
          <span style={{ width: `${progressPercent}%` }} />
        </div>
        <p className="retro-progress__meta">
          {t("meta.retro-print", { goal: goalFormatted, count: data.donorCount })}
        </p>
      </div>
      <p className="retro-progress__amount">{progressPercent} %</p>
    </section>
  );
}
