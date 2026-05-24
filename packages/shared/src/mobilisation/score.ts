/**
 * Mobilisation Score — composite per-tenant health indicator (Epic #434).
 *
 * The score lives in `@givernance/shared` because:
 *  1. The API layer needs it to project per-tenant rows on the super-admin
 *     finance dashboard (`/v1/superadmin/finance/summary`).
 *  2. The worker may need it for alerting (grade drop → CSM notification).
 *  3. The web layer renders the same five-component breakdown in tooltips
 *     and must speak the same vocabulary as the backend.
 *
 * The whole module is **pure functions**: zero IO, zero DB, zero clock.
 * The SQL CTE that feeds it lives in
 * `packages/api/src/modules/superadmin/finance/mobilisation.ts`.
 *
 * Domain rules (full doc: `docs/31-tenant-mobilization-score.md`):
 *  - Weights: 25% Activation + 25% Récurrence + 20% Échelle +
 *             20% Croissance + 10% Diversité (sum = 100).
 *  - Each component is clamped to [0, 100] BEFORE weighting so a single
 *    outlier component cannot pull the total above 100 or below 0.
 *  - K-anonymity gate: tenants with fewer than 5 unique donors in the
 *    period are anonymised — we still compute the components (useful for
 *    DPO + engineering debugging) but the public-facing grade + score
 *    are `null`. The UI surfaces this as "—" not "D".
 *  - Grade bands: A+ ≥ 90, A ≥ 75, B ≥ 60, C ≥ 40, D < 40.
 */

/** Minimum unique-donor count below which the tenant is anonymised. */
export const K_ANONYMITY_THRESHOLD = 5;

/** Per-component weights — MUST sum to 100. */
export const MOBILISATION_WEIGHTS = {
  activation: 25,
  recurrence: 25,
  scale: 20,
  growth: 20,
  diversity: 10,
} as const;

export type MobilisationGrade = "A+" | "A" | "B" | "C" | "D";

export interface MobilisationInput {
  /** Distinct donors with at least one cleared donation in the period. */
  uniqueDonorCount: number;
  /**
   * Activation (25%) — share of the tenant's all-time donor cohort that
   * gave at least one cleared donation in the current period. 0..1.
   */
  activationRate: number;
  /**
   * Récurrence (25%) — share of the period's revenue (cleared donations,
   * base currency) attributable to active recurring pledges. 0..1.
   */
  recurringRevenueRatio: number;
  /**
   * Échelle (20%) — total cleared-donation revenue in EUR (base
   * currency) for the period. Mapped through a log10 curve below so a
   * 10× revenue jump moves the component by +20 pts.
   */
  volumeBaseEur: number;
  /**
   * Croissance (20%) — period-over-period revenue growth.
   *   (period_revenue - previous_period_revenue) / previous_period_revenue
   * Clamped to [-1, +1] before mapping to 0..100 — a hyper-growth tenant
   * (5× in one period) is mapped to 100, not 500.
   */
  growthRate: number;
  /**
   * Diversité (10%) — 1 - HHI on payment_source share. 0..1. Lower HHI
   * (more diverse) → higher diversity component. A tenant with 100% of
   * its revenue on one channel scores 0; perfect uniformity across N
   * channels → close to 1.
   */
  channelDiversity: number;
}

export interface MobilisationComponents {
  /** Each component is the post-clamp, pre-weight value on a 0..100 scale. */
  activation: number;
  recurrence: number;
  scale: number;
  growth: number;
  diversity: number;
}

export interface MobilisationResult {
  grade: MobilisationGrade | null;
  score: number | null;
  components: MobilisationComponents;
  isAnonymised: boolean;
}

/** Numeric clamp helper — local so the module has zero deps. */
function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

/**
 * Échelle log-scale: maps a base-currency revenue figure to a 0..100
 * component. The intent is "every 10× jump in revenue earns +20 pts":
 *   €1 → 0       (log10(1)  = 0)
 *   €1 000 → 60   (log10(1k) = 3 → 60)
 *   €10 000 → 80   (log10(10k) = 4 → 80)
 *   €100 000 → 100 (clamped — the platform-wide curve plateaus before €1M)
 *
 * NB: the issue body refers to "+20 pts only for a 1000× jump"; we
 * interpret that as the **marginal** log behaviour past the plateau,
 * not the absolute span. The cap at €100k keeps the score from being
 * monopolised by a single mega-tenant — Givernance is positioned for
 * 2-200-staff NPOs, and we want the small high-activation tenant to be
 * able to reach A+ alongside a much larger but less engaged one.
 */
function scaleComponent(volumeBaseEur: number): number {
  const safe = Math.max(volumeBaseEur, 1);
  // 20 pts per order of magnitude, ceiling at 100.
  return clamp(20 * Math.log10(safe), 0, 100);
}

/**
 * Croissance linear-after-clamp: -100% → 0, 0% → 50, +100% → 100.
 * Hyper-growth (> +100%) is capped at 100; collapse beyond -100% is
 * mathematically impossible (revenue cannot go negative).
 */
function growthComponent(growthRate: number): number {
  const clamped = clamp(growthRate, -1, 1);
  return clamp((clamped + 1) * 50, 0, 100);
}

function gradeFromScore(score: number): MobilisationGrade {
  if (score >= 90) return "A+";
  if (score >= 75) return "A";
  if (score >= 60) return "B";
  if (score >= 40) return "C";
  return "D";
}

export interface ComputeOptions {
  /** Override the k-anonymity threshold (tests). Defaults to 5. */
  kAnonymityThreshold?: number;
}

/**
 * Compute the Mobilisation Score for one tenant in one period.
 *
 * Returns components even when anonymised so the engineering /
 * DPO-internal surface can inspect the raw breakdown — the public
 * `grade` / `score` are nulled instead.
 */
export function computeMobilisationScore(
  input: MobilisationInput,
  opts: ComputeOptions = {},
): MobilisationResult {
  const threshold = opts.kAnonymityThreshold ?? K_ANONYMITY_THRESHOLD;

  // Component computation (post-clamp, pre-weight; 0..100 scale).
  const components: MobilisationComponents = {
    activation: clamp(input.activationRate * 100, 0, 100),
    recurrence: clamp(input.recurringRevenueRatio * 100, 0, 100),
    scale: scaleComponent(input.volumeBaseEur),
    growth: growthComponent(input.growthRate),
    diversity: clamp(input.channelDiversity * 100, 0, 100),
  };

  if (input.uniqueDonorCount < threshold) {
    return {
      grade: null,
      score: null,
      components,
      isAnonymised: true,
    };
  }

  const weightedScore =
    (components.activation * MOBILISATION_WEIGHTS.activation +
      components.recurrence * MOBILISATION_WEIGHTS.recurrence +
      components.scale * MOBILISATION_WEIGHTS.scale +
      components.growth * MOBILISATION_WEIGHTS.growth +
      components.diversity * MOBILISATION_WEIGHTS.diversity) /
    100;

  const score = clamp(weightedScore, 0, 100);

  return {
    grade: gradeFromScore(score),
    score,
    components,
    isAnonymised: false,
  };
}
