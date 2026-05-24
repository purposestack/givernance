// #440 — RiskGrid + RiskItem
import { cn } from "@/lib/utils";

import styles from "./risk-grid.module.css";

export type RiskBadgeVariant = "ok" | "watch" | "alert";

export interface RiskBadge {
  variant: RiskBadgeVariant;
  /** Already-translated label (e.g. "Bien diversifié"). */
  label: string;
  /** Optional Material Symbols Outlined glyph (e.g. "check_circle"). */
  icon?: string;
}

export interface RiskItemProps {
  /** Already-translated metric label (e.g. "Concentration"). */
  label: string;
  /** Already-formatted value (e.g. "0,11", "41"). */
  value: string;
  /** Already-formatted suffix (e.g. " / 47", "%"). */
  suffix?: string;
  /** Already-translated short secondary line (e.g. "HHI · top tenant = 21,8%"). */
  secondary?: string;
  badge?: RiskBadge;
  /** Already-translated info tooltip on the icon. */
  infoTooltip?: string;
  className?: string;
}

const BADGE_CLASS: Record<RiskBadgeVariant, string> = {
  ok: "risk-badge--ok",
  watch: "risk-badge--watch",
  alert: "risk-badge--alert",
};

export function RiskItem({
  label,
  value,
  suffix,
  secondary,
  badge,
  infoTooltip,
  className,
}: RiskItemProps) {
  return (
    <div className={cn(styles.item, className)}>
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
        {suffix ? <span className={styles.suffix}>{suffix}</span> : null}
      </div>
      {secondary ? <div className={styles.secondary}>{secondary}</div> : null}
      {badge ? (
        <span className={cn(styles.badge, BADGE_CLASS[badge.variant])}>
          {badge.icon ? (
            <span className="material-symbols-outlined" aria-hidden="true">
              {badge.icon}
            </span>
          ) : null}
          {badge.label}
        </span>
      ) : null}
    </div>
  );
}

export interface RiskGridProps {
  children: React.ReactNode;
  className?: string;
}

export function RiskGrid({ children, className }: RiskGridProps) {
  return <div className={cn(styles.grid, className)}>{children}</div>;
}
