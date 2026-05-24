// #440 — VolumeRevenueChart (recharts <ComposedChart> + dual Y-axis)
//
// CRITICAL — issue head-comment + #440 acceptance criteria:
// the right Y-axis MUST set `domain={[0, volumeMax * 0.018]}` explicitly.
// recharts' auto-domain on a second axis collapses the revenue line
// because revenue is ~1.8 % of volume in absolute terms.
"use client";

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { cn } from "@/lib/utils";

import type { ChartPoint } from "./types";

import styles from "./volume-revenue-chart.module.css";

export interface VolumeRevenueChartLabels {
  /** Already-translated aria-label. */
  ariaLabel: string;
  /** Already-translated volume series label (tooltip). */
  volumeLabel: string;
  /** Already-translated revenue series label (tooltip). */
  revenueLabel: string;
  /** Caller-provided formatter for left-axis ticks (e.g. "€80k"). */
  formatVolumeTick: (value: number) => string;
  /** Caller-provided formatter for right-axis ticks. */
  formatRevenueTick: (value: number) => string;
  /** Caller-provided formatter for tooltip values. */
  formatVolume: (value: number) => string;
  formatRevenue: (value: number) => string;
}

export interface VolumeRevenueChartProps {
  data: ChartPoint[];
  /**
   * Max volume across the period (caller-computed). The right Y-axis
   * domain is forced to `[0, volumeMax * 0.018]` per the issue spec.
   */
  volumeMax: number;
  labels: VolumeRevenueChartLabels;
  className?: string;
}

interface ChartTooltipPayloadEntry {
  // recharts' `dataKey` is `string | number | ((d: unknown) => unknown)`.
  // We pass strings ("volume" / "revenue") so accept the function form
  // structurally without using it.
  dataKey?: string | number | ((obj: unknown) => unknown);
  value?: number | string | ReadonlyArray<number | string>;
  payload?: ChartPoint;
}

interface ChartTooltipProps {
  active?: boolean;
  payload?: readonly ChartTooltipPayloadEntry[];
  labels: VolumeRevenueChartLabels;
}

function numericValue(entry: ChartTooltipPayloadEntry | undefined, fallback: number): number {
  const v = entry?.value;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isNaN(n) ? fallback : n;
  }
  return fallback;
}

function ChartTooltip({ active, payload, labels }: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const datum = payload[0]?.payload;
  if (!datum) return null;
  const volEntry = payload.find((p) => p.dataKey === "volume");
  const revEntry = payload.find((p) => p.dataKey === "revenue");
  return (
    <div className={styles.tooltip}>
      <div className={styles.tooltipDate}>{datum.label}</div>
      <div className={styles.tooltipRow}>
        <span className={styles.tooltipSwatch} data-series="volume" aria-hidden="true" />
        <span>{labels.volumeLabel}</span>
        <span className={styles.tooltipValue}>
          {labels.formatVolume(numericValue(volEntry, datum.volume))}
        </span>
      </div>
      <div className={styles.tooltipRow}>
        <span className={styles.tooltipSwatch} data-series="revenue" aria-hidden="true" />
        <span>{labels.revenueLabel}</span>
        <span className={styles.tooltipValue}>
          {labels.formatRevenue(numericValue(revEntry, datum.revenue))}
        </span>
      </div>
    </div>
  );
}

export function VolumeRevenueChart({
  data,
  volumeMax,
  labels,
  className,
}: VolumeRevenueChartProps) {
  if (data.length === 0) return null;

  // Right Y-axis domain: explicit 1.8% multiplier per acceptance criteria.
  // recharts' auto-domain would collapse the revenue line to ~zero.
  const revenueMax = volumeMax * 0.018;

  return (
    <div className={cn(styles.wrap, className)} role="img" aria-label={labels.ariaLabel}>
      <ResponsiveContainer width="100%" height={280}>
        <ComposedChart data={data} margin={{ top: 20, right: 54, bottom: 8, left: 4 }}>
          <defs>
            <linearGradient id="vrc-volGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-primary)" stopOpacity={0.18} />
              <stop offset="100%" stopColor="var(--color-primary)" stopOpacity={0.01} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--color-outline-variant)" strokeDasharray="3 3" />
          <XAxis
            dataKey="label"
            tick={{ fill: "var(--color-on-surface-variant)", fontSize: 10 }}
            stroke="var(--color-outline-variant)"
          />
          <YAxis
            yAxisId="volume"
            domain={[0, volumeMax]}
            tickFormatter={labels.formatVolumeTick}
            tick={{ fill: "var(--color-on-surface-variant)", fontSize: 10 }}
            stroke="var(--color-outline-variant)"
          />
          <YAxis
            yAxisId="revenue"
            orientation="right"
            domain={[0, revenueMax]}
            tickFormatter={labels.formatRevenueTick}
            tick={{ fill: "var(--color-on-surface-variant)", fontSize: 10 }}
            stroke="var(--color-outline-variant)"
          />
          <Tooltip
            content={(props) => <ChartTooltip {...props} labels={labels} />}
            cursor={{
              stroke: "var(--color-on-surface-variant)",
              strokeDasharray: "3 3",
              opacity: 0.5,
            }}
            // Default recharts positioning — the lib follows the cursor
            // and auto-flips near edges. Our previous custom `position`
            // / `allowEscapeViewBox` overrides were over-engineering;
            // trust the library.
            wrapperStyle={{ zIndex: 10, pointerEvents: "none" }}
          />
          <Area
            yAxisId="volume"
            type="monotone"
            dataKey="volume"
            stroke="var(--color-primary)"
            strokeWidth={2.4}
            fill="url(#vrc-volGrad)"
            isAnimationActive={false}
          />
          <Line
            yAxisId="revenue"
            type="monotone"
            dataKey="revenue"
            stroke="var(--color-tertiary)"
            strokeWidth={2}
            strokeDasharray="6 4"
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
