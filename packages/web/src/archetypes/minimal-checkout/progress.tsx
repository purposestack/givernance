import { formatCurrency } from "@/lib/format";
import type { ProgressSlotProps } from "../types";
import { useProgressModel } from "../use-progress-model";

export function MinimalProgress({ data }: ProgressSlotProps) {
  const model = useProgressModel(data);
  if (!model) return null;
  const { goalCents, progressPercent, ariaValueText } = model;

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
        <p className="minimal-progress__label">Raised</p>
        <p className="minimal-progress__amount">
          {formatCurrency(data.raisedCents, data.locale, data.defaultCurrency)}{" "}
          <span>/ {formatCurrency(goalCents, data.locale, data.defaultCurrency)}</span>
        </p>
      </div>
      <div className="minimal-progress__pct">{progressPercent} %</div>
      <div className="minimal-progress__bar" aria-hidden="true">
        <span style={{ width: `${progressPercent}%` }} />
      </div>
    </section>
  );
}
