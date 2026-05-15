import { formatCurrency } from "@/lib/format";
import type { ProgressSlotProps } from "../types";

/**
 * Activist `Progress` — black counter strip with brand-coloured
 * eyebrow labels. Tabular-nums on every figure per slot contract.
 */
export function ActivistProgress({ data }: ProgressSlotProps) {
  const hasGoal = data.goalAmountCents !== null && data.goalAmountCents > 0;
  // Render the counter strip whenever a goal is set — donors need to
  // see the target on day 1 even before the first donation.
  if (!hasGoal) return null;

  const goal = data.goalAmountCents ?? 0;
  const pct = goal > 0 ? Math.min(100, Math.round((data.raisedCents / goal) * 100)) : 0;

  return (
    <div
      className="activist-progress"
      style={
        {
          "--brand-primary": data.colorPrimary,
        } as React.CSSProperties
      }
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={`${pct} percent funded — ${data.raisedCents / 100} of ${goal / 100} ${data.defaultCurrency}`}
    >
      <div className="activist-progress__row">
        <div className="activist-progress__cell">
          <p className="activist-progress__label">RAISED</p>
          <p className="activist-progress__value">{formatCurrency(data.raisedCents, "en")}</p>
        </div>
        <div className="activist-progress__cell">
          <p className="activist-progress__label">GOAL</p>
          <p className="activist-progress__value">{formatCurrency(goal, "en")}</p>
        </div>
        <div className="activist-progress__cell">
          <p className="activist-progress__label">SUPPORTERS</p>
          <p className="activist-progress__value">{data.donorCount.toLocaleString("en")}</p>
        </div>
        <div className="activist-progress__cell">
          <p className="activist-progress__label">% FUNDED</p>
          <p className="activist-progress__value">{pct}%</p>
        </div>
      </div>
      <div className="activist-progress__bar">
        <span style={{ width: `${pct}%`, backgroundColor: data.colorPrimary }} />
      </div>
    </div>
  );
}
