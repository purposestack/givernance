"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { DEFAULT_LOCALE, formatCurrency, formatCurrencyRounded } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Data shape for a single monetary amount with optional conversion context. */
export interface CurrencyAmountData {
  /** Amount in the original currency (display cents, not minor units) */
  originalAmount: number;
  /** ISO 4217 code of the original currency */
  originalCurrency: string;
  /** Converted amount for display (in user's display currency) */
  displayAmount?: number;
  /** ISO 4217 code of the display currency */
  displayCurrency?: string;
  /** FX rate used for conversion */
  exchangeRate?: number;
  /** ISO timestamp of the rate */
  exchangeRateTimestamp?: string;
}

interface CurrencyAmountProps {
  data: CurrencyAmountData;
  /**
   * - "single": direct amount, no conversion indicator
   * - "aggregate": approximate total, ≈ prefix, tooltip with conversion info
   */
  variant?: "single" | "aggregate";
  locale?: string;
  /** When true, render without decimals (KPI / stat-card contexts). */
  rounded?: boolean;
  className?: string;
}

export function CurrencyAmount({
  data,
  variant = "single",
  locale,
  rounded = false,
  className,
}: CurrencyAmountProps) {
  const formatAmount = (amount: number, currency: string) =>
    (rounded ? formatCurrencyRounded : formatCurrency)(amount, locale ?? DEFAULT_LOCALE, currency);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const tooltipId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);

  const hasConversion =
    variant === "aggregate" &&
    data.displayAmount !== undefined &&
    data.displayCurrency !== undefined &&
    data.displayCurrency !== data.originalCurrency;

  const displayedAmount = hasConversion
    ? (data.displayAmount ?? data.originalAmount)
    : data.originalAmount;
  const displayedCurrency = hasConversion
    ? (data.displayCurrency ?? data.originalCurrency)
    : data.originalCurrency;
  const formattedAmount = formatAmount(displayedAmount, displayedCurrency);

  const closeTooltip = useCallback(() => setTooltipOpen(false), []);

  useEffect(() => {
    if (!tooltipOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeTooltip();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [tooltipOpen, closeTooltip]);

  if (!hasConversion) {
    // Simple variant — no tooltip needed
    const srText = `${formattedAmount}${variant === "aggregate" ? " (approximate total)" : ""}`;
    return (
      <span className={cn("inline-flex items-center", className)}>
        <span className="sr-only">{srText}</span>
        {variant === "aggregate" && (
          <span className="font-mono tabular-nums" aria-hidden="true">
            ≈ {formattedAmount}
          </span>
        )}
        {variant !== "aggregate" && (
          <span className="font-mono tabular-nums" aria-hidden="true">
            {formattedAmount}
          </span>
        )}
      </span>
    );
  }

  // Aggregate variant with conversion tooltip
  const originalFormatted = formatAmount(data.originalAmount, data.originalCurrency);
  const rateDate = data.exchangeRateTimestamp
    ? new Date(data.exchangeRateTimestamp).toLocaleDateString(locale ?? "en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : null;

  const tooltipContent = [
    `Converted from ${originalFormatted}`,
    data.exchangeRate
      ? `Rate: 1 ${data.originalCurrency} = ${data.exchangeRate.toFixed(4)} ${data.displayCurrency}`
      : null,
    rateDate ? `As of ${rateDate}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const srLabel = `Approximately ${formattedAmount}, converted from ${originalFormatted}`;

  return (
    <span className={cn("relative inline-flex items-center gap-1", className)}>
      <span className="sr-only">{srLabel}</span>
      <span className="font-mono tabular-nums" aria-hidden="true">
        ≈ {formattedAmount}
      </span>
      <button
        ref={buttonRef}
        type="button"
        aria-label="Show conversion details"
        aria-expanded={tooltipOpen}
        aria-describedby={tooltipId}
        onClick={() => setTooltipOpen((v) => !v)}
        onBlur={(e) => {
          if (!e.currentTarget.parentElement?.contains(e.relatedTarget)) {
            closeTooltip();
          }
        }}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-surface-container-highest text-on-surface-variant text-[10px] font-bold leading-none hover:bg-surface-container focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
      >
        i
      </button>
      {tooltipOpen && (
        <span
          id={tooltipId}
          role="tooltip"
          className="absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2 whitespace-nowrap rounded-[var(--radius-sm)] bg-inverse-surface px-2 py-1 text-xs text-inverse-on-surface shadow-md"
        >
          {tooltipContent}
        </span>
      )}
    </span>
  );
}
