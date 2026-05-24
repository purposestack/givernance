// #440 — GradeChip
import { cn } from "@/lib/utils";

import type { Grade } from "./types";

export interface GradeChipProps {
  grade: Grade;
  /** Score 0-100. Rendered as the small numeric suffix. */
  score: number;
  /** `display` renders larger (hero block); `sm` (default) is the tile/list variant. */
  size?: "sm" | "display";
  /**
   * Already-translated aria-label override. Default: "<letter> · <score>/100".
   */
  ariaLabel?: string;
  className?: string;
}

const VARIANT_CLASS: Record<Grade, string> = {
  aplus: "grade-chip--aplus",
  a: "grade-chip--a",
  b: "grade-chip--b",
  c: "grade-chip--c",
  d: "grade-chip--d",
};

const LETTER: Record<Grade, string> = {
  aplus: "A+",
  a: "A",
  b: "B",
  c: "C",
  d: "D",
};

export function GradeChip({ grade, score, size = "sm", ariaLabel, className }: GradeChipProps) {
  const letter = LETTER[grade];
  return (
    <span
      role="img"
      className={cn(
        "grade-chip",
        VARIANT_CLASS[grade],
        size === "display" && "grade-chip--display",
        className,
      )}
      aria-label={ariaLabel ?? `${letter} · ${score}/100`}
      title={`${letter} · ${score}/100`}
    >
      <span className="ltr" aria-hidden="true">
        {letter}
      </span>
      <span className="n" aria-hidden="true">
        {score}
      </span>
    </span>
  );
}
