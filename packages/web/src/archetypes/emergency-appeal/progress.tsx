import { useLocale, useTranslations } from "next-intl";
import type { ProgressSlotProps } from "../types";
import { useProgressModel } from "../use-progress-model";

/**
 * Emergency Appeal `Progress` — oversized counter on a black slab.
 * The raised number is the visual anchor; goal/percent quieter.
 */
export function EmergencyProgress({ data }: ProgressSlotProps) {
  const locale = useLocale();
  const t = useTranslations("publicDonationPage");
  const model = useProgressModel(data);
  if (!model) return null;
  const { progressPercent, goalFormatted, ariaValueText } = model;

  // Split the raised amount around its currency symbol so we can paint
  // the symbol in the brand colour on the dark slab. `formatToParts`
  // rather than a leading-non-digit regex: the symbol LEADS in English
  // ("€55,464.96") but TRAILS in French ("55 464,96 €"). Same options as
  // `formatCurrency` so the figure matches the other archetypes.
  const parts = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: data.defaultCurrency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).formatToParts(data.raisedCents / 100);
  const symbolIndex = parts.findIndex((part) => part.type === "currency");
  const joinParts = (slice: Intl.NumberFormatPart[]) => slice.map((part) => part.value).join("");
  const beforeSymbol =
    symbolIndex === -1 ? joinParts(parts) : joinParts(parts.slice(0, symbolIndex));
  const symbol = parts[symbolIndex]?.value ?? "";
  const afterSymbol = symbolIndex === -1 ? "" : joinParts(parts.slice(symbolIndex + 1));

  return (
    <section
      className="emergency-progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progressPercent}
      aria-valuetext={ariaValueText}
    >
      <p className="emergency-progress__label">{t("metrics.raised")}</p>
      <p className="emergency-progress__amount">
        {beforeSymbol}
        <span className="currency">{symbol}</span>
        {afterSymbol}
      </p>
      <p className="emergency-progress__goal">
        {t("progress.meta.emergency-appeal", {
          goal: goalFormatted,
          percent: progressPercent,
          count: data.donorCount,
        })}
      </p>
      <div className="emergency-progress__bar" aria-hidden="true">
        <span style={{ width: `${progressPercent}%` }} />
      </div>
    </section>
  );
}
