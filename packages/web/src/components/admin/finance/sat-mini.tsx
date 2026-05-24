// #440 — SatMini
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { FreshPip, type FreshPipProps } from "./fresh-pip";

import styles from "./sat-mini.module.css";

export type SatMiniTone = "neutral" | "danger";

export interface SatMiniCta {
  /** Already-translated link text. */
  label: string;
  href: string;
}

export interface SatMiniProps {
  /** Already-translated label (e.g. "NPS tenants"). */
  label: string;
  /** Already-formatted value (e.g. "+42", "4,3", "4"). */
  value: string;
  /** Already-formatted unit (e.g. "/ 100", "/ 5", "tenants"). */
  unit?: string;
  /** Already-translated "indicateur retardé · legacy" label when applicable. */
  legacy?: string;
  /** Freshness pip props. Omit on always-fresh tiles. */
  freshness?: Omit<FreshPipProps, "className">;
  /** danger = error-container background (used for "À recontacter"). */
  tone?: SatMiniTone;
  /** Optional info-tooltip on the label. */
  infoTooltip?: string;
  cta?: SatMiniCta;
  /**
   * When true, apply `.is-stale-data` to the DISPLAY children (label,
   * value, legacy). Never applies to the CTA — WCAG 1.4.3.
   */
  isStale?: boolean;
  /** DOM id (e.g. for "À recontacter" jump-link from topbar). */
  id?: string;
  className?: string;
}

export function SatMini({
  label,
  value,
  unit,
  legacy,
  freshness,
  tone = "neutral",
  infoTooltip,
  cta,
  isStale = false,
  id,
  className,
}: SatMiniProps) {
  return (
    <div id={id} className={cn(styles.satMini, tone === "danger" && styles.danger, className)}>
      <div className={cn(isStale && "is-stale-data")}>
        <div className={styles.label}>
          {label}
          {infoTooltip ? (
            <span
              role="img"
              className={cn("material-symbols-outlined", styles.infoIcon)}
              aria-label={infoTooltip}
              title={infoTooltip}
            >
              info
            </span>
          ) : null}
        </div>
        <div className={styles.value}>
          {value}
          {unit ? <small>{unit}</small> : null}
        </div>
        {legacy ? <span className={styles.legacy}>{legacy}</span> : null}
      </div>
      {freshness ? <FreshPip {...freshness} className={styles.pip} /> : null}
      {cta ? (
        // Anchor lives OUTSIDE the `is-stale-data` wrapper so it stays
        // at full contrast even when isStale=true (WCAG 1.4.3).
        <a href={cta.href} className={styles.cta}>
          {cta.label as ReactNode} →
        </a>
      ) : null}
    </div>
  );
}
