import { formatCurrency } from "@/lib/format";
import type { ProgressSlotProps } from "../types";
import { useProgressModel } from "../use-progress-model";

export function RetroProgress({ data }: ProgressSlotProps) {
  const model = useProgressModel(data);
  if (!model) return null;
  const { goalCents, progressPercent, ariaValueText } = model;

  return (
    <section
      className="retro-progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progressPercent}
      aria-valuetext={ariaValueText}
    >
      <p className="retro-progress__amount">{formatCurrency(data.raisedCents, "en")}</p>
      <div>
        <div className="retro-progress__bar" aria-hidden="true">
          <span style={{ width: `${progressPercent}%` }} />
        </div>
        <p className="retro-progress__meta">
          of {formatCurrency(goalCents, "en")} · {data.donorCount.toLocaleString("en")} subscribers
        </p>
      </div>
      <p className="retro-progress__amount">{progressPercent} %</p>
    </section>
  );
}
