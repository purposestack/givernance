// #440 — FreshPip
import { cn } from "@/lib/utils";

import type { FreshBand } from "./types";

export interface FreshPipProps {
  /** Band derived SERVER-SIDE from `Date.now() - lastCollectedAt`. */
  band: FreshBand;
  /** Source timestamp — surfaced in the tooltip for transparency. */
  lastCollectedAt: Date;
  /** Whole-day delta since `lastCollectedAt`. Already computed by caller. */
  ageDays: number;
  /**
   * Already-translated label (e.g. "à jour · 3 j", "dernière enquête ·
   * il y a 125 j"). The component renders this verbatim — translation
   * happens in the consuming page.
   */
  label: string;
  /** Optional already-translated tooltip override. */
  tooltip?: string;
  className?: string;
}

const VARIANT_CLASS: Record<FreshBand, string> = {
  ok: "fresh-pip--ok",
  soon: "fresh-pip--soon",
  stale: "fresh-pip--stale",
};

const ICON: Record<FreshBand, string> = {
  ok: "check_circle",
  soon: "schedule",
  stale: "warning",
};

export function FreshPip({
  band,
  lastCollectedAt,
  ageDays,
  label,
  tooltip,
  className,
}: FreshPipProps) {
  // Title is intentionally NOT a substitute for an aria-label — most SR
  // engines ignore `title` on a non-interactive span. The label itself
  // carries the meaning (e.g. "dernière enquête · il y a 125 j").
  const titleText = tooltip ?? `${lastCollectedAt.toISOString()} · ${ageDays} j`;
  return (
    <span
      className={cn("fresh-pip", VARIANT_CLASS[band], className)}
      title={titleText}
      data-age-days={ageDays}
    >
      <span className="material-symbols-outlined" aria-hidden="true">
        {ICON[band]}
      </span>
      {label}
    </span>
  );
}
