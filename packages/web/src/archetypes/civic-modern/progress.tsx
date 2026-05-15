import { formatCurrency } from "@/lib/format";
import type { ProgressSlotProps } from "../types";
import { useProgressModel } from "../use-progress-model";

/**
 * Civic Modern `Progress` — 4-cell transparency grid (raised, goal,
 * supporters, % funded). Stats foreground; the bar is secondary.
 */
export function CivicProgress({ data }: ProgressSlotProps) {
  const model = useProgressModel(data);
  if (!model) return null;
  const { goalCents, progressPercent, ariaValueText } = model;

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
        <p className="civic-progress__label">Raised</p>
        <p className="civic-progress__value">{formatCurrency(data.raisedCents, "en")}</p>
      </div>
      <div className="civic-progress__cell">
        <p className="civic-progress__label">Goal</p>
        <p className="civic-progress__value">{formatCurrency(goalCents, "en")}</p>
      </div>
      <div className="civic-progress__cell">
        <p className="civic-progress__label">Supporters</p>
        <p className="civic-progress__value">{data.donorCount.toLocaleString("en")}</p>
      </div>
      <div className="civic-progress__cell">
        <p className="civic-progress__label">% funded</p>
        <p className="civic-progress__value">{progressPercent} %</p>
      </div>
      <div className="civic-progress__bar" aria-hidden="true">
        <span style={{ width: `${progressPercent}%` }} />
      </div>
    </section>
  );
}
