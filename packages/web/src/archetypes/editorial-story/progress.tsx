import { formatCurrency } from "@/lib/format";
import type { ProgressSlotProps } from "../types";
import { useProgressModel } from "../use-progress-model";

export function EditorialProgress({ data }: ProgressSlotProps) {
  const model = useProgressModel(data);
  if (!model) return null;
  const { goalCents, progressPercent, ariaValueText } = model;

  return (
    <section className="editorial-progress" aria-label="Campaign progress">
      <p className="editorial-progress__amount">{formatCurrency(data.raisedCents, "en")}</p>
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
          {formatCurrency(goalCents, "en")} goal · {data.donorCount.toLocaleString("en")}{" "}
          contributors · {progressPercent} % of target
        </p>
      </div>
    </section>
  );
}
