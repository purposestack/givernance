"use client";

import { useMemo } from "react";
import { useCountUp } from "@/hooks/use-count-up";

export interface CountUpProps {
  /** Final value — rendered as-is on the server and once the sweep lands. */
  value: number;
  /** BCP 47 locale tag for Intl.NumberFormat (e.g. "fr-CH"). */
  locale: string;
  /** Passed through to Intl.NumberFormat (currency, maximumFractionDigits…). */
  formatOptions?: Intl.NumberFormatOptions;
  className?: string;
}

/**
 * KPI count-up synced to the ADR-035 data-draw sweep (600 ms — rule A7 in
 * docs/adrs/adr-035-loading-motion-choreography.md). Wraps `useCountUp` in a
 * client component so it can be embedded inside async Server Components:
 * SSR (and no-JS clients) render the FINAL formatted value; the count from 0
 * only plays client-side after hydration, once per mount. Collapses to the
 * final value under prefers-reduced-motion (rule E17).
 */
export function CountUp({ value, locale, formatOptions, className }: CountUpProps) {
  const current = useCountUp(value);
  const formatter = useMemo(
    () => new Intl.NumberFormat(locale, formatOptions),
    [locale, formatOptions],
  );

  return <span className={className}>{formatter.format(current)}</span>;
}
