// #440 — DistributionHistogram (recharts <BarChart>)
"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";

import type { HistogramBin } from "./types";

export interface DistributionHistogramLabels {
  /** Already-translated aria-label. */
  ariaLabel: string;
  /** Already-translated mean callout label (e.g. "Moy · 76"). */
  meanLabel: string;
  /** Already-translated y-axis ticks (top → bottom). Length must match yTicks. */
  yTicks: string[];
}

export interface DistributionHistogramProps {
  bins: HistogramBin[];
  /** Mean value position within the bins (e.g. score 76 → between bin 70-80 and 80-90). */
  mean: number;
  /** Max y value for axis scaling. */
  yMax: number;
  /** Bin x-axis domain (min, max). Used to position the mean reference line. The
   *  reference line is positioned by interpolating `mean` onto the bin label
   *  whose centre is closest — recharts' category axis cannot take an
   *  arbitrary numeric x. */
  xDomain: [number, number];
  labels: DistributionHistogramLabels;
}

function nearestBinLabel(bins: HistogramBin[], mean: number, [xMin, xMax]: [number, number]) {
  if (bins.length === 0) return undefined;
  const span = xMax - xMin || 1;
  const frac = (mean - xMin) / span;
  const idx = Math.max(0, Math.min(bins.length - 1, Math.round(frac * (bins.length - 1))));
  return bins[idx]?.label;
}

export function DistributionHistogram({
  bins,
  mean,
  yMax,
  xDomain,
  labels,
}: DistributionHistogramProps) {
  const meanRefLabel = nearestBinLabel(bins, mean, xDomain);
  return (
    <div role="img" aria-label={labels.ariaLabel} style={{ width: "100%", height: 220 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={bins} margin={{ top: 24, right: 16, bottom: 36, left: 8 }}>
          <CartesianGrid
            stroke="var(--color-outline-variant)"
            strokeDasharray="3 3"
            vertical={false}
          />
          <XAxis
            dataKey="label"
            tick={{ fill: "var(--color-on-surface-variant)", fontSize: 10 }}
            stroke="var(--color-outline-variant)"
            interval={0}
          />
          <YAxis
            domain={[0, yMax]}
            ticks={labels.yTicks.map((t) => Number(t)).filter((n) => !Number.isNaN(n))}
            tick={{ fill: "var(--color-on-surface-variant)", fontSize: 10 }}
            stroke="var(--color-outline-variant)"
          />
          <Bar dataKey="count" radius={[3, 3, 0, 0]} isAnimationActive={false}>
            {bins.map((bin) => (
              <Cell key={bin.label} fill={bin.color ?? "var(--color-primary)"} />
            ))}
            <LabelList
              dataKey="count"
              position="top"
              style={{
                fill: "var(--color-on-surface)",
                fontFamily: "var(--font-mono)",
                fontSize: 10,
              }}
            />
            <LabelList
              dataKey="sublabel"
              position="bottom"
              offset={18}
              style={{
                fill: "var(--color-on-surface-variant)",
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                fontWeight: 600,
              }}
            />
          </Bar>
          {meanRefLabel ? (
            <ReferenceLine
              x={meanRefLabel}
              stroke="var(--color-on-surface)"
              strokeWidth={1.5}
              strokeDasharray="5 3"
              label={{
                value: labels.meanLabel,
                position: "top",
                fill: "var(--color-on-surface)",
                fontSize: 10,
                fontWeight: 600,
              }}
            />
          ) : null}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
