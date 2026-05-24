// #440 — RefundGauge (CSS-only, NOT a chart lib component)
import { cn } from "@/lib/utils";

import styles from "./refund-gauge.module.css";

export interface RefundGaugeThresholds {
  /** Healthy upper bound, e.g. 1 (= 1 %). */
  ok: number;
  /** Watch upper bound, e.g. 5 (= 5 %). */
  watch: number;
  /** Hard ceiling for the gauge, e.g. 8 (= 8 %). */
  danger: number;
}

export interface RefundGaugeLabels {
  /** Already-translated aria-label (e.g. "0,42% — zone saine"). */
  ariaLabel: string;
  /** Already-translated tick labels in order (low → high). */
  ticks: string[];
}

export interface RefundGaugeProps {
  /** Current value, in the same unit as the thresholds (typically %). */
  valuePercent: number;
  thresholds: RefundGaugeThresholds;
  labels: RefundGaugeLabels;
  className?: string;
}

export function RefundGauge({ valuePercent, thresholds, labels, className }: RefundGaugeProps) {
  // Cursor position is `value / danger * 100` clamped to [0, 100]. The
  // gauge gradient itself uses `thresholds` boundaries as colour stops
  // exposed via CSS custom properties.
  const cursorPct = Math.max(0, Math.min(100, (valuePercent / thresholds.danger) * 100));
  const okStopPct = (thresholds.ok / thresholds.danger) * 100;
  const watchStopPct = (thresholds.watch / thresholds.danger) * 100;
  const cssVars = {
    "--gauge-ok-stop": `${okStopPct}%`,
    "--gauge-watch-stop": `${watchStopPct}%`,
    "--cursor-x": `${cursorPct}%`,
  } as React.CSSProperties;
  return (
    <div className={cn(styles.gauge, className)} style={cssVars}>
      <div className={styles.track} role="img" aria-label={labels.ariaLabel}>
        {/* Cursor X-position flows through `--cursor-x` (Exception 2:
            caller-derived numeric percent → CSS custom property). The
            `left: var(--cursor-x)` declaration lives in the module CSS. */}
        <div className={styles.cursor} />
      </div>
      <div className={styles.ticks}>
        {labels.ticks.map((tick, i) => {
          const pct =
            i === 0 ? 0 : i === labels.ticks.length - 1 ? 100 : i === 1 ? okStopPct : watchStopPct;
          return (
            <span
              key={tick}
              className={styles.tick}
              style={{ "--tick-x": `${pct}%` } as React.CSSProperties}
            >
              {tick}
            </span>
          );
        })}
      </div>
    </div>
  );
}
