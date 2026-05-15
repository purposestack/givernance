import { formatCurrency } from "@/lib/format";
import type { ProgressSlotProps } from "../types";

/**
 * Cosmic Gradient `Progress` — glass card with a thin gradient bar
 * and tabular-nums counter. Sits below the hero in the scroll-reveal
 * layout.
 */
export function CosmicProgress({ data }: ProgressSlotProps) {
  const hasGoal = data.goalAmountCents !== null && data.goalAmountCents > 0;
  // Render whenever a goal is set — donors see the target on day 1.
  if (!hasGoal) return null;

  const goal = data.goalAmountCents ?? 0;
  const pct = goal > 0 ? Math.min(100, Math.round((data.raisedCents / goal) * 100)) : 0;

  return (
    <section
      className="cosmic-progress"
      style={{ "--brand-primary": data.colorPrimary } as React.CSSProperties}
      aria-label="Campaign progress"
    >
      <p className="cosmic-progress__amount">{formatCurrency(data.raisedCents, "en")}</p>
      <div>
        <div
          className="cosmic-progress__bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-valuetext={`${pct} percent funded — ${data.raisedCents / 100} of ${goal / 100} ${data.defaultCurrency}`}
        >
          <span style={{ width: `${pct}%` }} />
        </div>
        <p className="cosmic-progress__meta">
          of <strong>{formatCurrency(goal, "en")}</strong> goal ·{" "}
          {data.donorCount.toLocaleString("en")} backers · <strong>{pct} %</strong> funded
        </p>
      </div>
    </section>
  );
}
