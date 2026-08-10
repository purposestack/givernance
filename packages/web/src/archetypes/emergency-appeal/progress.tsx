import { formatCurrency, getCurrencySymbol } from "@/lib/format";
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

  // Format the raised amount but split off the currency symbol so we can
  // paint it in the brand colour on the dark slab. The symbol can sit before
  // (en: "€55,464.96") or after (fr: "55 464,96 €") the digits depending on
  // locale, so resolve it independently and strip it from the formatted value
  // rather than assuming a fixed position.
  const currency = getCurrencySymbol(data.defaultCurrency, data.locale);
  const formatted = formatCurrency(data.raisedCents, data.locale, data.defaultCurrency);
  const amount = formatted.replace(currency, "").trim();

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
        ▸ of {formatCurrency(goalCents, data.locale, data.defaultCurrency)} · {progressPercent} %
        funded · {data.donorCount.toLocaleString(data.locale)} contributors
      </p>
      <div className="emergency-progress__bar" aria-hidden="true">
        <span style={{ width: `${progressPercent}%` }} />
      </div>
    </section>
  );
}
