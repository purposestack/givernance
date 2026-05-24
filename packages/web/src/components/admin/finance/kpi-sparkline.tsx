// #440 — KPISparkline (recharts <LineChart>, no-axis)
"use client";

import { Area, ComposedChart, Line, ResponsiveContainer } from "recharts";

import type { SparklinePoint } from "./types";

export interface KPISparklineProps {
  points: SparklinePoint[];
  /** Stroke colour token (e.g. `var(--color-primary)`). */
  color: string;
  /** Optional area fill (rgba with low alpha) — when present, renders below the line. */
  fillTint?: string;
  /** Already-translated aria-label. Default: omitted (decorative). */
  ariaLabel?: string;
}

export function KPISparkline({ points, color, fillTint, ariaLabel }: KPISparklineProps) {
  const chart = (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={points} margin={{ top: 1, right: 0, bottom: 1, left: 0 }}>
        {fillTint ? (
          <Area
            type="monotone"
            dataKey="y"
            stroke="none"
            fill={fillTint}
            isAnimationActive={false}
          />
        ) : null}
        <Line
          type="monotone"
          dataKey="y"
          stroke={color}
          strokeWidth={1.8}
          dot={false}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
  if (ariaLabel) {
    return (
      <div className="kpi-spark" role="img" aria-label={ariaLabel}>
        {chart}
      </div>
    );
  }
  return (
    <div className="kpi-spark" aria-hidden="true">
      {chart}
    </div>
  );
}
