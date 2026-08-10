import { formatCurrency } from "@/lib/format";
import type { ProgressSlotProps } from "../types";
import { useProgressModel } from "../use-progress-model";

export function CalmProgress({ data }: ProgressSlotProps) {
  const model = useProgressModel(data);
  if (!model) return null;
  const { progressPercent, ariaValueText } = model;

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
        <strong>{formatCurrency(data.raisedCents, data.locale, data.defaultCurrency)}</strong>{" "}
        raised · <strong>{progressPercent} %</strong> of goal ·{" "}
        {data.donorCount.toLocaleString(data.locale)} supporters
      </p>
    </div>
  );
}
