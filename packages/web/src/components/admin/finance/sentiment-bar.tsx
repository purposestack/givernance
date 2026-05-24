// #440 — SentimentBar
import { cn } from "@/lib/utils";
import styles from "./sentiment-bar.module.css";
import type { FinanceTone, SentimentSegment } from "./types";

export interface SentimentBarProps {
  segments: SentimentSegment[];
  /**
   * Already-translated summary for the bar as a whole — read by SR
   * users in place of the visual segments (e.g. "47% très déçus,
   * 34% plutôt déçus, 19% pas déçus").
   */
  summaryLabel: string;
  /**
   * When true, render percent text inside each segment. Defaults true.
   * SR users always get the summary label; this controls visual only.
   */
  showLabels?: boolean;
  className?: string;
}

// Cast: `noUncheckedIndexedAccess` widens CSS-module imports to
// `string | undefined`. These keys are defined in the colocated
// module so the runtime values are always strings.
const TONE_CLASS = {
  primary: styles.tonePrimary,
  tertiary: styles.toneTertiary,
  secondary: styles.toneSecondary,
  indigo: styles.toneIndigo,
  danger: styles.toneDanger,
  neutral: styles.toneNeutral,
} as Record<FinanceTone, string>;

export function SentimentBar({
  segments,
  summaryLabel,
  showLabels = true,
  className,
}: SentimentBarProps) {
  // role="img" + summary aria-label — inner segments are aria-hidden so
  // SR users get a single coherent summary rather than per-segment chunks.
  // CSS custom property `--seg-flex` carries the dynamic flex-grow value
  // (Exception 2 in the issue spec: caller-driven numeric percent), while
  // the colour is class-driven via a `FinanceTone` enum — never an
  // inline `background` string (BLOCKING per #434 design+a11y review).
  return (
    <div className={cn(styles.sentimentBar, className)} role="img" aria-label={summaryLabel}>
      {segments.map((segment) => (
        <div
          key={segment.key}
          className={cn(styles.sentimentSeg, TONE_CLASS[segment.tone])}
          style={{ "--seg-flex": segment.percent } as React.CSSProperties}
          aria-hidden="true"
        >
          {showLabels ? `${segment.percent}%` : null}
        </div>
      ))}
    </div>
  );
}
