import { formatCurrency } from "@/lib/format";
import type { ProgressSlotProps } from "../types";
import { useProgressModel } from "../use-progress-model";

/**
 * Cosmic Gradient `Progress` — glass card with a thin gradient bar
 * and tabular-nums counter. Sits below the hero in the scroll-reveal
 * layout.
 */
export function CosmicProgress({ data }: ProgressSlotProps) {
  const model = useProgressModel(data);
  if (!model) return null;
  const { goalCents, progressPercent, ariaValueText } = model;

  return (
    <section className="cosmic-progress" aria-label="Campaign progress">
      <p className="cosmic-progress__amount">
        {formatCurrency(data.raisedCents, data.locale, data.defaultCurrency)}
      </p>
      <div>
        <div
          className="cosmic-progress__bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progressPercent}
          aria-valuetext={ariaValueText}
        >
          <span style={{ width: `${progressPercent}%` }} />
        </div>
        <p className="cosmic-progress__meta">
          of <strong>{formatCurrency(goalCents, data.locale, data.defaultCurrency)}</strong> goal ·{" "}
          {data.donorCount.toLocaleString(data.locale)} backers ·{" "}
          <strong>{progressPercent} %</strong> funded
        </p>
      </div>
    </section>
  );
}
