import { formatCurrency } from "@/lib/format";
import type { ProgressSlotProps } from "../types";

export function CalmProgress({ data }: ProgressSlotProps) {
  const hasGoal = data.goalAmountCents !== null && data.goalAmountCents > 0;
  // Render whenever a goal is set — donors see the target on day 1.
  if (!hasGoal) return null;
  const goal = data.goalAmountCents ?? 0;
  const pct = goal > 0 ? Math.min(100, Math.round((data.raisedCents / goal) * 100)) : 0;

  return (
    <div
      className="calm-progress"
      style={{ "--brand-primary": data.colorPrimary } as React.CSSProperties}
    >
      <div
        className="calm-progress__bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={`${pct} percent funded — ${data.raisedCents / 100} of ${goal / 100} ${data.defaultCurrency}`}
      >
        <span style={{ width: `${pct}%` }} />
      </div>
      <p className="calm-progress__meta">
        <strong>{formatCurrency(data.raisedCents, "en")}</strong> raised · <strong>{pct} %</strong>{" "}
        of goal · {data.donorCount.toLocaleString("en")} supporters
      </p>
    </div>
  );
}
