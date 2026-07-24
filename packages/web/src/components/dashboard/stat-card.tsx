import Link from "next/link";

import { StatCardTrend } from "@/components/dashboard/stat-card-trend";

export interface StatCardTrendData {
  value: number;
  label: string;
  detail: { current: string; previous: string };
}

/**
 * Inline style feeding the ADR-035 `.reveal-item` cascade order — the shared
 * utility in globals.css reads `--cascade-i` for its animation-delay (rule A2).
 */
export function cascadeStyle(index: number): React.CSSProperties {
  return { "--cascade-i": index } as React.CSSProperties;
}

/**
 * Dashboard KPI card (extracted from dashboard/page.tsx for issue #229).
 *
 * Issue #229 (demo 30/04): each card states its time window (`period`) and —
 * when `href` is set — the whole card deep-links to the detailed report via
 * a stretched-link overlay. The overlay keeps the interactive trend badge
 * (a Radix tooltip trigger) OUT of the anchor: nesting a button inside a
 * link is invalid HTML and confuses AT, so the badge is lifted above the
 * overlay with `z-10` instead.
 *
 * ADR-035: the card is one animated unit (`.reveal-item` + `--cascade-i`);
 * hover feedback is colors only (rule 13) and the link overlay carries no
 * transform, so the entrance never gains a containing block (rule E18).
 */
export function StatCard({
  label,
  value,
  description,
  period,
  href,
  hrefAriaLabel,
  valueClassName,
  icon: Icon,
  color = "primary",
  trend,
  cascadeIndex,
}: {
  label: string;
  value: React.ReactNode;
  description: string;
  /** Time bounds of the figure, e.g. "Mois en cours (juillet 2026)". */
  period?: string;
  /** When set, the whole card becomes a link to the detailed report. */
  href?: string;
  /** Accessible name for the stretched link (defaults to `label`). */
  hrefAriaLabel?: string;
  valueClassName?: string;
  icon?: React.ElementType;
  color?: "primary" | "secondary" | "tertiary" | "amber";
  trend?: StatCardTrendData;
  /** ADR-035 cascade order — the card (value + trend badge) is the animated unit. */
  cascadeIndex: number;
}) {
  // Semantic icon background: maps stat type to palette.
  // `amber` used for deadline/warning cards (grant deadlines).
  const colorStyles = {
    primary: "bg-primary-fixed text-on-primary-fixed-variant",
    secondary: "bg-secondary-fixed text-on-secondary-fixed-variant",
    tertiary: "bg-tertiary-fixed text-on-tertiary-fixed-variant",
    amber: "bg-amber-light text-amber-dark",
  };

  return (
    <article
      className={`reveal-item relative min-h-36 rounded-2xl bg-surface-container-lowest p-5 border border-border-brand ${
        href ? "transition-colors hover:border-primary/50 focus-within:border-primary/50" : ""
      }`.trim()}
      style={cascadeStyle(cascadeIndex)}
    >
      {href ? (
        <Link
          href={href}
          aria-label={hrefAriaLabel ?? label}
          className="absolute inset-0 z-0 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        />
      ) : null}
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-on-surface-variant">{label}</p>
        <div className="flex items-center gap-2">
          {trend ? (
            // Lifted above the stretched link so the tooltip stays reachable.
            <span className="relative z-10">
              <StatCardTrend value={trend.value} label={trend.label} detail={trend.detail} />
            </span>
          ) : null}
          {Icon ? (
            <div
              className={`flex h-10 w-10 items-center justify-center rounded-xl ${colorStyles[color]}`}
            >
              <Icon size={20} aria-hidden="true" />
            </div>
          ) : null}
        </div>
      </div>
      <p
        className={`mt-3 font-heading text-4xl font-normal leading-tight text-on-surface ${valueClassName ?? ""}`.trim()}
      >
        {value}
      </p>
      <p className="mt-2 text-sm text-on-surface-variant">{description}</p>
      {period ? <p className="mt-1 text-xs text-on-surface-variant/80">{period}</p> : null}
    </article>
  );
}
