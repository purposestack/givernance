import { formatCurrency } from "@/lib/format";
import type { ProgressSlotProps } from "../types";
import { useProgressModel } from "../use-progress-model";

/**
 * Emergency Appeal `Progress` — oversized counter on a black slab.
 * The raised number is the visual anchor; goal/percent quieter.
 */
export function EmergencyProgress({ data }: ProgressSlotProps) {
  const model = useProgressModel(data);
  if (!model) return null;
  const { goalCents, progressPercent, ariaValueText } = model;

  // Format the raised amount but extract the currency symbol so we
  // can paint it in the brand colour on the dark slab.
  const formatted = formatCurrency(data.raisedCents, "en");
  // `Intl.NumberFormat` puts the symbol first for en-US (€55,464.96
  // becomes "€55,464.96"). Split off the leading non-digit chunk.
  const match = formatted.match(/^([^\d]+)(.+)$/);
  const currency = match?.[1] ?? "";
  const amount = match?.[2] ?? formatted;

  return (
    <section
      className="emergency-progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progressPercent}
      aria-valuetext={ariaValueText}
    >
      <p className="emergency-progress__label">Raised so far</p>
      <p className="emergency-progress__amount">
        <span className="currency">{currency}</span>
        {amount}
      </p>
      <p className="emergency-progress__goal">
        ▸ of {formatCurrency(goalCents, "en")} · {progressPercent} % funded ·{" "}
        {data.donorCount.toLocaleString("en")} contributors
      </p>
      <div className="emergency-progress__bar" aria-hidden="true">
        <span style={{ width: `${progressPercent}%` }} />
      </div>
    </section>
  );
}
