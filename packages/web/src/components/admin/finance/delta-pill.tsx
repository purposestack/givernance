// #440 — DeltaPill
import { cn } from "@/lib/utils";

import type { DeltaDirection } from "./types";

export interface DeltaPillProps {
  direction: DeltaDirection;
  /** Already-formatted label (e.g. "+18,2%", "−0,08 pt", "+5 pts vs T-1"). */
  label: string;
  /**
   * Optional Material Symbols Outlined glyph (e.g. "arrow_upward"). If
   * omitted, no icon is rendered — useful for flat/neutral pills.
   */
  icon?: string;
  /**
   * Overrides the auto-derived aria-label. By default the component
   * synthesises one from `direction` + `label` so screen-readers hear
   * "Hausse de 18,2%" rather than just "+18,2%".
   */
  ariaLabel?: string;
  className?: string;
}

const VARIANT_CLASS: Record<DeltaDirection, string> = {
  up: "delta-pill--up",
  down: "delta-pill--down",
  flat: "delta-pill--flat",
  cost: "delta-pill--cost",
};

export function DeltaPill({ direction, label, icon, ariaLabel, className }: DeltaPillProps) {
  return (
    <span
      className={cn("delta-pill", VARIANT_CLASS[direction], className)}
      role="status"
      aria-label={ariaLabel ?? label}
    >
      {icon ? (
        <span className="material-symbols-outlined" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {label}
    </span>
  );
}
