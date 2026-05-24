// #440 — MobilisationScoreCard
import { cn } from "@/lib/utils";

import { DeltaPill } from "./delta-pill";
import { GradeChip } from "./grade-chip";
import styles from "./mobilisation-score-card.module.css";
import type { Grade } from "./types";

export interface MobilisationScoreCardLabels {
  /** Already-translated header (e.g. "Score de Mobilisation"). */
  title: string;
  /** Already-translated info-tooltip prose. */
  infoTooltip: string;
  /** Already-translated period comparison label (e.g. "vs 30 j préc. · moy. pondérée volume"). */
  periodLabel: string;
  /** Already-translated delta label (e.g. "+3,4 pts"). */
  deltaLabel: string;
  /** Already-translated bottom-block prose. Supports React nodes for inline emphasis. */
  footnote: React.ReactNode;
  /** Already-formatted "out of" (e.g. "/ 100"). */
  outOf?: string;
}

export interface MobilisationScoreCardProps {
  /** Aggregate score 0-100. */
  score: number;
  grade: Grade;
  /** Delta in points (signed). */
  delta: number;
  /** Tenant count for transparency footer. */
  tenantCount: number;
  labels: MobilisationScoreCardLabels;
  className?: string;
}

export function MobilisationScoreCard({
  score,
  grade,
  delta,
  tenantCount,
  labels,
  className,
}: MobilisationScoreCardProps) {
  return (
    <div className={cn(styles.block, className)} data-tenant-count={tenantCount}>
      <div className={styles.label}>
        <span className="material-symbols-outlined" aria-hidden="true">
          monitoring
        </span>
        {labels.title}
        <span
          role="img"
          className={cn("material-symbols-outlined", styles.infoIcon)}
          aria-label={labels.infoTooltip}
          title={labels.infoTooltip}
        >
          info
        </span>
      </div>
      <div className={styles.score}>
        <GradeChip
          grade={grade}
          score={score}
          size="display"
          ariaLabel={`${grade.toUpperCase()} ${score} / 100`}
        />
        <span className={styles.scoreInline}>
          <span className={styles.scoreNum}>{score}</span>
          <span className={styles.scoreOut}>&nbsp;{labels.outOf ?? "/ 100"}</span>
        </span>
      </div>
      <div className={styles.meta}>
        <DeltaPill
          direction={delta >= 0 ? "up" : "down"}
          icon={delta >= 0 ? "arrow_upward" : "arrow_downward"}
          label={labels.deltaLabel}
        />
        <span className={styles.foot}>{labels.periodLabel}</span>
      </div>
      <p className={styles.bottom}>{labels.footnote}</p>
    </div>
  );
}
