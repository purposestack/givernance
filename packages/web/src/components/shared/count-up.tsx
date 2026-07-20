"use client";

import { useMemo, useRef } from "react";
import { useCountUp } from "@/hooks/use-count-up";

export interface CountUpProps {
  /** Final value — rendered as-is on the server and once the sweep lands. */
  value: number;
  /** BCP 47 locale tag for Intl.NumberFormat (e.g. "fr-CH"). */
  locale: string;
  /**
   * Passed through to Intl.NumberFormat (currency, fraction digits…).
   * Defaults to `maximumFractionDigits: 0` so integer KPIs never show
   * decimals mid-count; caller options win, so currency call-sites keep
   * their explicit two-decimal formatting.
   */
  formatOptions?: Intl.NumberFormatOptions;
  className?: string;
}

/**
 * KPI count-up synced to the ADR-035 data-draw sweep (600 ms — rule A7 in
 * docs/adrs/adr-035-loading-motion-choreography.md). Wraps `useCountUp` in a
 * client component so it can be embedded inside async Server Components:
 * SSR (and no-JS clients) render the FINAL formatted value; the count from 0
 * only plays client-side, and only while the surrounding entrance
 * choreography (`.reveal-item` / `.cascade` slot) still hides the number —
 * a visible KPI never re-counts from a fake 0. Collapses to the final value
 * under prefers-reduced-motion (rule E17).
 */
export function CountUp({ value, locale, formatOptions, className }: CountUpProps) {
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const current = useCountUp(value, { hostRef });
  const formatter = useMemo(
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 0, ...formatOptions }),
    [locale, formatOptions],
  );

  return (
    <span ref={hostRef} className={className}>
      {formatter.format(current)}
    </span>
  );
}
