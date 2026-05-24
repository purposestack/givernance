// #440 — CurrencyDonut (recharts <PieChart>)
"use client";

import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";

import { cn } from "@/lib/utils";
import styles from "./currency-donut.module.css";
import type { CurrencySlice, FinanceTone } from "./types";

export interface CurrencyDonutProps {
  slices: CurrencySlice[];
  /** Already-translated aria-label (e.g. "EUR 68%, GBP 19%, CHF 13%"). */
  ariaLabel: string;
  /** Already-translated centre label (e.g. "3 devises"). */
  centerLabel?: { count: string | number; label: string };
  className?: string;
}

// Cast: `noUncheckedIndexedAccess` widens CSS-module imports to
// `string | undefined`. These keys are defined in the colocated module.
const TONE_CLASS = {
  primary: styles.tonePrimary,
  tertiary: styles.toneTertiary,
  secondary: styles.toneSecondary,
  indigo: styles.toneIndigo,
  danger: styles.toneDanger,
  neutral: styles.toneNeutral,
} as Record<FinanceTone, string>;

/**
 * recharts `<Cell>` requires a `fill` prop. We resolve the active
 * design-token value at render time from a CSS custom property attached
 * to a hidden probe element so we never hard-code hex codes here —
 * white-label themes that swap the `--color-*` palette keep working.
 *
 * Falling back to `currentColor` keeps SSR/jsdom render-safe (the
 * computed style is empty in jsdom; the `Cell` swatch wouldn't render
 * regardless because recharts requires a measured ResponsiveContainer).
 */
const TONE_TOKEN: Record<FinanceTone, string> = {
  primary: "var(--color-primary)",
  tertiary: "var(--color-tertiary)",
  secondary: "var(--color-secondary)",
  indigo: "var(--color-indigo, var(--color-indigo-text))",
  danger: "var(--color-error)",
  neutral: "var(--color-on-surface-variant)",
};

export function CurrencyDonut({ slices, ariaLabel, centerLabel, className }: CurrencyDonutProps) {
  return (
    <div className={cn(styles.wrap, className)}>
      <div className={styles.donut} role="img" aria-label={ariaLabel}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="percent"
              nameKey="key"
              innerRadius="60%"
              outerRadius="85%"
              paddingAngle={2}
              startAngle={90}
              endAngle={-270}
              stroke="none"
              isAnimationActive={false}
            >
              {slices.map((slice) => (
                <Cell key={slice.key} fill={TONE_TOKEN[slice.tone]} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        {centerLabel ? (
          <div className={styles.center} aria-hidden="true">
            <span className={styles.centerCount}>{centerLabel.count}</span>
            <span className={styles.centerLabel}>{centerLabel.label}</span>
          </div>
        ) : null}
      </div>
      <div className={styles.legend}>
        {slices.map((slice) => (
          <div key={slice.key} className={styles.row}>
            <span className={cn(styles.swatch, TONE_CLASS[slice.tone])} aria-hidden="true" />
            <span className={styles.code}>{slice.label}</span>
            {slice.amount ? <span className={styles.amount}>{slice.amount}</span> : <span />}
            <span className={styles.pct}>{slice.percent.toString().replace(".", ",")}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
