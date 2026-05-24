// #440 — PMFCard
import { cn } from "@/lib/utils";

import { DeltaPill } from "./delta-pill";
import styles from "./pmf-card.module.css";
import { PMFMarker } from "./pmf-marker";
import { SentimentBar } from "./sentiment-bar";
import type { FinanceTone, SentimentSegment } from "./types";

export interface PMFCardCount {
  key: string;
  /** Already-translated legend label (e.g. "Très déçus"). */
  label: string;
  /** Absolute response count. */
  count: number;
  /** Semantic tone matching the segment in the bar (class-driven, no inline style). */
  tone: FinanceTone;
}

// Cast: `noUncheckedIndexedAccess` widens CSS-module imports to
// `string | undefined`. These keys are defined in the colocated module.
const TONE_CLASS = {
  primary: styles.tonePrimary,
  tertiary: styles.toneTertiary,
  secondary: styles.toneSecondary,
  indigo: styles.toneIndigo,
  danger: styles.toneDanger,
  neutral: styles.toneNeutral,
} as Record<FinanceTone, string>;

export interface PMFCardLabels {
  /** Already-translated "Product-Market Fit" title. */
  title: string;
  /** Already-translated info-icon tooltip. */
  infoTooltip: string;
  /** Already-translated threshold prose (e.g. "tenants « très déçus » — au-dessus du seuil…"). */
  thresholdProse: React.ReactNode;
  /** Already-translated delta label (e.g. "+5 pts vs T-1"). */
  deltaLabel: string;
  /** Already-translated SentimentBar summary. */
  segmentsSummary: string;
  /** Already-translated marker tag (e.g. "seuil · 40%"). */
  markerLabel: string;
  /** Already-translated stale-overlay note (only used when isStale=true). */
  staleNote?: string;
}

export interface PMFCardProps {
  /** PMF percentage 0-100 (very-disappointed share). */
  percent: number;
  /** Fit threshold (default Sean Ellis: 40). */
  threshold: number;
  /** Period-over-period delta in percentage points. */
  deltaPts: number;
  segments: SentimentSegment[];
  counts: PMFCardCount[];
  /**
   * BLOCKING a11y (WCAG 1.4.3): when true, only DISPLAY children are
   * dimmed via `.is-stale-data` — the actionable descendants (handled
   * by the parent <StaleBanner>, NOT this card) stay at full contrast.
   * This prop NEVER promotes itself to a className on the card root.
   */
  isStale: boolean;
  /** ISO timestamp of the last survey closure. Used for the stale note. */
  lastCollectedAt: Date;
  /** Total responses underlying the bar (e.g. n=38). */
  sampleSize: number;
  labels: PMFCardLabels;
  className?: string;
}

export function PMFCard({
  percent,
  threshold,
  deltaPts,
  segments,
  counts,
  isStale,
  lastCollectedAt,
  sampleSize,
  labels,
  className,
}: PMFCardProps) {
  // CRITICAL: `is-stale-data` is applied to the inner display wrapper
  // ONLY, never to the card root. A consuming page renders a
  // <StaleBanner> sibling above this card; that banner's buttons must
  // never be dimmed. Co-locating the dimming on the card root would
  // also dim a future "View raw responses" link if one were added
  // inside the card — which is exactly the WCAG 1.4.3 footgun the
  // BLOCKING note in #440 calls out.
  const displayClass = cn(styles.display, isStale && "is-stale-data");

  return (
    <div className={cn(styles.card, className)} data-stale={isStale ? "true" : undefined}>
      <div className={displayClass}>
        <div className={styles.label}>
          {labels.title}{" "}
          <button
            type="button"
            className={cn("material-symbols-outlined", styles.infoGlyph)}
            aria-label={labels.infoTooltip}
            title={labels.infoTooltip}
          >
            info
          </button>
        </div>
        <div className={styles.headline}>
          <span className={styles.big}>
            {percent}
            <span className={styles.unit}>%</span>
          </span>
          <span className={styles.deltaCol}>
            <DeltaPill
              direction={deltaPts >= 0 ? "up" : "down"}
              icon={deltaPts >= 0 ? "arrow_upward" : "arrow_downward"}
              label={labels.deltaLabel}
            />
            <span className={styles.threshold} data-threshold-pct={threshold}>
              {labels.thresholdProse}
              {" · "}
              <span className={styles.sampleSize}>n={sampleSize}</span>
            </span>
          </span>
        </div>
        <div className={styles.barWrapper}>
          <SentimentBar segments={segments} summaryLabel={labels.segmentsSummary} />
          <PMFMarker thresholdPercent={threshold} label={labels.markerLabel} />
        </div>
        <div className={styles.legend}>
          {counts.map((c) => (
            <span key={c.key} className={styles.legendItem}>
              <span className={cn(styles.swatch, TONE_CLASS[c.tone])} aria-hidden="true" />
              {c.label} <b>{c.count}</b>
            </span>
          ))}
        </div>
        {isStale && labels.staleNote ? (
          <div className="stale-overlay-note">
            <span className="material-symbols-outlined" aria-hidden="true">
              history
            </span>
            {labels.staleNote}
            <span className={styles.srOnly}> ({lastCollectedAt.toISOString()})</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
