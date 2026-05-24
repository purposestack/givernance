// #440 — KPITile
import { cn } from "@/lib/utils";

import { DeltaPill } from "./delta-pill";
import { KPISparkline } from "./kpi-sparkline";
import styles from "./kpi-tile.module.css";
import type { DeltaDirection, SparklinePoint } from "./types";

export interface KPITileDelta {
  direction: DeltaDirection;
  /** Already-translated label (e.g. "+18,2%"). */
  label: string;
  icon?: string;
}

export interface KPITileProps {
  /** Already-translated short label (e.g. "Volume des dons"). */
  label: string;
  /** Already-formatted value (e.g. "€1 284 530"). */
  value: string;
  /** Already-formatted suffix (e.g. ",00", "/mois"). */
  suffix?: string;
  delta?: KPITileDelta;
  /** Already-translated footnote (e.g. "13 080 dons · vs 30 j préc."). */
  foot?: string;
  /** Material Symbols Outlined icon glyph (e.g. "savings"). */
  icon: string;
  /**
   * Background colour for the icon chip. Pass a token var (e.g.
   * `var(--color-primary-fixed)`) — exposed via a CSS custom property
   * so we don't inline-style the element.
   */
  iconBg: string;
  /** Icon glyph colour token. */
  iconColor: string;
  sparklinePoints?: SparklinePoint[];
  /** Sparkline stroke colour. */
  sparklineColor?: string;
  /** Sparkline area fill (with alpha). */
  sparklineFill?: string;
  /** Optional "enriched since" note (e.g. "enrichi depuis le 2026-05-23"). */
  enrichNote?: string;
  /** Optional already-translated tooltip on the info-icon next to the label. */
  infoTooltip?: string;
  className?: string;
}

export function KPITile({
  label,
  value,
  suffix,
  delta,
  foot,
  icon,
  iconBg,
  iconColor,
  sparklinePoints,
  sparklineColor = "var(--color-primary)",
  sparklineFill,
  enrichNote,
  infoTooltip,
  className,
}: KPITileProps) {
  // The icon chip's background+colour pair are dynamic per-tile values
  // (Volume = green, Revenu = brown, …) — exposed via CSS custom
  // properties so the className-only ban is honoured. The wrapper sets
  // --kpi-icon-bg / --kpi-icon-color via the style attribute (Exception
  // 2: dynamic colour from caller-provided design tokens).
  const cssVars = {
    "--kpi-icon-bg": iconBg,
    "--kpi-icon-color": iconColor,
  } as React.CSSProperties;

  return (
    <article className={cn(styles.kpi, "reveal", className)} style={cssVars}>
      <div className={styles.head}>
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
        <div className={styles.iconChip}>
          <span className="material-symbols-outlined" aria-hidden="true">
            {icon}
          </span>
        </div>
      </div>
      <div className={styles.value}>
        {value}
        {suffix ? <span className={styles.suffix}>{suffix}</span> : null}
      </div>
      <div className={styles.meta}>
        {delta ? (
          <DeltaPill direction={delta.direction} icon={delta.icon} label={delta.label} />
        ) : null}
        {foot ? <span className={styles.foot}>{foot}</span> : null}
      </div>
      {enrichNote ? (
        <span className={styles.enrichNote}>
          <span className="material-symbols-outlined" aria-hidden="true">
            sync
          </span>
          {enrichNote}
        </span>
      ) : null}
      {sparklinePoints && sparklinePoints.length > 0 ? (
        <KPISparkline points={sparklinePoints} color={sparklineColor} fillTint={sparklineFill} />
      ) : null}
    </article>
  );
}
