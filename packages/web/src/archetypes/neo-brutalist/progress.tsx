import { formatCurrency } from "@/lib/format";
import type { ProgressSlotProps } from "../types";
import { useProgressModel } from "../use-progress-model";

export function NeoBrutalistProgress({ data }: ProgressSlotProps) {
  const model = useProgressModel(data);
  if (!model) return null;
  const { goalCents, progressPercent, ariaValueText } = model;

  return (
    <section
      className="neo-progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progressPercent}
      aria-valuetext={ariaValueText}
    >
      <p className="neo-progress__amount">
        {formatCurrency(data.raisedCents, data.locale, data.defaultCurrency)}
      </p>
      <div>
        <div className="neo-progress__bar" aria-hidden="true">
          <span style={{ width: `${progressPercent}%` }} />
        </div>
        <p className="neo-progress__meta">
          / {formatCurrency(goalCents, data.locale, data.defaultCurrency)} · {progressPercent}% ·{" "}
          {data.donorCount.toLocaleString(data.locale)} backers
        </p>
      </div>
    </section>
  );
}
