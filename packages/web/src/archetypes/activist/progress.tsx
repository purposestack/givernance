import { formatCurrency } from "@/lib/format";
import type { ProgressSlotProps } from "../types";
import { useProgressModel } from "../use-progress-model";

/**
 * Activist `Progress` — black counter strip with brand-coloured
 * eyebrow labels. Tabular-nums on every figure per slot contract.
 */
export function ActivistProgress({ data }: ProgressSlotProps) {
  const model = useProgressModel(data);
  if (!model) return null;
  const { goalCents, progressPercent, ariaValueText } = model;

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
          <p className="activist-progress__label">RAISED</p>
          <p className="activist-progress__value">
            {formatCurrency(data.raisedCents, data.locale, data.defaultCurrency)}
          </p>
        </div>
        <div className="activist-progress__cell">
          <p className="activist-progress__label">GOAL</p>
          <p className="activist-progress__value">
            {formatCurrency(goalCents, data.locale, data.defaultCurrency)}
          </p>
        </div>
        <div className="activist-progress__cell">
          <p className="activist-progress__label">SUPPORTERS</p>
          <p className="activist-progress__value">{data.donorCount.toLocaleString(data.locale)}</p>
        </div>
        <div className="activist-progress__cell">
          <p className="activist-progress__label">% FUNDED</p>
          <p className="activist-progress__value">{progressPercent}%</p>
        </div>
      </div>
      <div className="activist-progress__bar">
        <span style={{ width: `${progressPercent}%`, background: "var(--brand-primary)" }} />
      </div>
    </div>
  );
}
