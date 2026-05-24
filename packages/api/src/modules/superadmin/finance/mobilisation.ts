/**
 * Mobilisation Score — per-tenant aggregator (Epic #434, issue #438).
 *
 * Single-round-trip SQL CTE that materialises the five raw signals the
 * pure scoring function in `@givernance/shared`'s
 * `computeMobilisationScore` consumes. Lives on the super-admin
 * surface — never tenant-facing — and runs on `systemDb` because the
 * platform aggregate is cross-tenant by design.
 *
 * Full domain doc: `docs/31-tenant-mobilization-score.md`.
 *
 * Performance budget: one round-trip per dashboard render. The five
 * CTEs join on `donations.org_id` + `pledges.org_id` + `tenants.id`
 * with no per-row Node-side loop. Expected p95 < 200ms on a 100-tenant
 * platform with ~1M donations (validation pending against staging — see
 * Open question in docs/30 § 8).
 */

import {
  computeMobilisationScore,
  type MobilisationInput,
  type MobilisationResult,
} from "@givernance/shared";
import { sql } from "drizzle-orm";
import { systemDb } from "../../../lib/db.js";

export interface MobilisationPeriod {
  /** Inclusive lower bound of the current period (UTC). */
  from: Date;
  /** Exclusive upper bound of the current period (UTC). */
  to: Date;
}

/** One tenant's mobilisation snapshot, raw + scored. */
export interface TenantMobilisationRow {
  orgId: string;
  tenantName: string;
  tenantStatus: string;
  /** Raw signal inputs that fed the score — exposed for the tooltip. */
  input: MobilisationInput;
  /** Period-base-currency revenue, used as the weighting key for the platform aggregate. */
  volumeBaseCents: number;
  /** The composite result (grade, score, components, anonymisation flag). */
  result: MobilisationResult;
}

interface RawRow extends Record<string, unknown> {
  org_id: string;
  tenant_name: string;
  tenant_status: string;
  unique_donor_count: string | number;
  cohort_size: string | number;
  period_volume_base_cents: string | number;
  recurring_monthly_base_cents: string | number;
  previous_volume_base_cents: string | number;
  channel_hhi: string | number | null;
}

function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : Number.parseFloat(value);
}

function buildInputFromRaw(row: RawRow): {
  input: MobilisationInput;
  volumeBaseCents: number;
} {
  const uniqueDonorCount = toNumber(row.unique_donor_count);
  const cohortSize = toNumber(row.cohort_size);
  const periodVolume = toNumber(row.period_volume_base_cents);
  const recurringMonthly = toNumber(row.recurring_monthly_base_cents);
  const previousVolume = toNumber(row.previous_volume_base_cents);
  const hhi = toNumber(row.channel_hhi);

  // Activation: share of the all-time cohort that gave in the period.
  const activationRate = cohortSize > 0 ? uniqueDonorCount / cohortSize : 0;

  // Récurrence: share of period revenue from active recurring pledges.
  // The SQL CTE already scaled MRR by `monthsInPeriod`, so the raw row's
  // `recurring_monthly_base_cents` is the period-equivalent recurring
  // revenue. Cap at 1.0 — for tenants whose pledges briefly outpace
  // their realised donations (e.g. a paused-then-resumed pledge ahead
  // of the next charge), the ratio shouldn't blow past 100%.
  const recurringRevenueRatio = periodVolume > 0 ? Math.min(recurringMonthly / periodVolume, 1) : 0;

  // Croissance: period-over-period growth, base currency cents → ratio.
  const growthRate = previousVolume > 0 ? (periodVolume - previousVolume) / previousVolume : 0;

  // Diversité: 1 - HHI (HHI in [0, 1]; missing → 0 channels → treat as 0 diversity).
  const channelDiversity = hhi > 0 ? Math.max(0, 1 - hhi) : 0;

  return {
    input: {
      uniqueDonorCount,
      activationRate,
      recurringRevenueRatio,
      volumeBaseEur: periodVolume / 100, // cents → EUR base currency
      growthRate,
      channelDiversity,
    },
    volumeBaseCents: periodVolume,
  };
}

export interface ComputePerTenantOptions {
  /** Optionally narrow to one tenant (still uses systemDb for consistency). */
  tenantId?: string;
}

/**
 * One SQL round-trip computing the five raw signals for every
 * non-archived/non-suspended tenant in the given period, then scoring
 * each row through the pure shared function.
 *
 * CROSS-TENANT INTENTIONAL: platform-wide mobilisation requires
 * aggregation across all tenants; the super-admin route caller is
 * authenticated and authorised at the route layer (see issue #437).
 */
export async function computeMobilisationPerTenant(
  period: MobilisationPeriod,
  opts: ComputePerTenantOptions = {},
): Promise<TenantMobilisationRow[]> {
  const { from, to } = period;
  const periodMs = to.getTime() - from.getTime();
  // Previous period of equal length, immediately preceding `from`.
  const previousFrom = new Date(from.getTime() - periodMs);
  const previousTo = from;

  // Months covered by the period — used to scale MRR (monthly recurring
  // revenue) onto the period's denominator so the Récurrence ratio is
  // comparable to the period's cleared donations total. 30.44d = avg
  // month length; we round to the nearest 0.01 to keep ratios stable.
  const monthsInPeriod = Math.max(periodMs / (1000 * 60 * 60 * 24 * 30.44), 0.01);

  const tenantFilter = opts.tenantId ? sql`AND t.id = ${opts.tenantId}::uuid` : sql``;

  // CROSS-TENANT INTENTIONAL: platform-wide aggregate read; no
  // `set_config('app.current_organization_id', …)` because we *want*
  // every org's rows.
  const result = await systemDb.execute<RawRow>(sql`
    WITH
    -- All-time cohort (denominator for Activation) per org.
    cohort AS (
      SELECT
        d.org_id,
        COUNT(DISTINCT d.constituent_id) AS cohort_size
      FROM donations d
      WHERE d.status = 'cleared'
      GROUP BY d.org_id
    ),

    -- Period revenue + period unique donors per org.
    period_revenue AS (
      SELECT
        d.org_id,
        COALESCE(SUM(d.amount_base_cents), 0) AS period_volume_base_cents,
        COUNT(DISTINCT d.constituent_id) AS unique_donor_count
      FROM donations d
      WHERE d.status = 'cleared'
        AND d.donated_at >= ${from}
        AND d.donated_at <  ${to}
      GROUP BY d.org_id
    ),

    -- Previous period revenue per org (for Croissance).
    previous_revenue AS (
      SELECT
        d.org_id,
        COALESCE(SUM(d.amount_base_cents), 0) AS previous_volume_base_cents
      FROM donations d
      WHERE d.status = 'cleared'
        AND d.donated_at >= ${previousFrom}
        AND d.donated_at <  ${previousTo}
      GROUP BY d.org_id
    ),

    -- Active recurring revenue per org, normalised to monthly cents.
    -- frequency='monthly' kept as-is; 'yearly' divided by 12.
    recurring_revenue AS (
      SELECT
        p.org_id,
        COALESCE(SUM(
          CASE p.frequency
            WHEN 'monthly' THEN p.amount_base_cents::numeric
            WHEN 'yearly'  THEN p.amount_base_cents::numeric / 12
            ELSE 0
          END
        ), 0) AS monthly_base_cents
      FROM pledges p
      WHERE p.status = 'active'
      GROUP BY p.org_id
    ),

    -- HHI on payment_source. Subquery-wrapped so the per-channel share
    -- (a window-like calculation) is computed BEFORE the SUM(POW(share, 2))
    -- aggregate runs — Postgres rejects mixing window + aggregate in the
    -- same SELECT level, hence the explicit nesting.
    channel_shares AS (
      SELECT
        org_id,
        payment_source,
        SUM(amount_base_cents)::numeric AS source_volume,
        SUM(SUM(amount_base_cents)) OVER (PARTITION BY org_id)::numeric AS org_total
      FROM donations
      WHERE status = 'cleared'
        AND donated_at >= ${from}
        AND donated_at <  ${to}
      GROUP BY org_id, payment_source
    ),
    channel_hhi AS (
      SELECT
        org_id,
        SUM(POW(source_volume / NULLIF(org_total, 0), 2))::numeric AS channel_hhi
      FROM channel_shares
      GROUP BY org_id
    )

    SELECT
      t.id            AS org_id,
      t.name          AS tenant_name,
      t.status        AS tenant_status,
      COALESCE(pr.unique_donor_count, 0)             AS unique_donor_count,
      COALESCE(c.cohort_size, 0)                     AS cohort_size,
      COALESCE(pr.period_volume_base_cents, 0)       AS period_volume_base_cents,
      COALESCE(rr.monthly_base_cents * ${monthsInPeriod}, 0)
                                                     AS recurring_monthly_base_cents,
      COALESCE(prv.previous_volume_base_cents, 0)    AS previous_volume_base_cents,
      ch.channel_hhi                                 AS channel_hhi
    FROM tenants t
    LEFT JOIN cohort           c   ON c.org_id   = t.id
    LEFT JOIN period_revenue   pr  ON pr.org_id  = t.id
    LEFT JOIN previous_revenue prv ON prv.org_id = t.id
    LEFT JOIN recurring_revenue rr ON rr.org_id  = t.id
    LEFT JOIN channel_hhi      ch  ON ch.org_id  = t.id
    WHERE t.status NOT IN ('archived', 'suspended')
      ${tenantFilter}
    ORDER BY t.name ASC
  `);

  const rows = result.rows as RawRow[];

  return rows.map((row) => {
    const { input, volumeBaseCents } = buildInputFromRaw(row);
    return {
      orgId: row.org_id,
      tenantName: row.tenant_name,
      tenantStatus: row.tenant_status,
      input,
      volumeBaseCents,
      result: computeMobilisationScore(input),
    };
  });
}

export interface MobilisationPlatformAggregate {
  /**
   * Platform-wide score: SUM(tenant_score × tenant_volume) / SUM(tenant_volume),
   * skipping anonymised tenants.
   */
  score: number | null;
  /** Same grade-bands as the per-tenant score. */
  grade: MobilisationResult["grade"];
  /** How many tenants contributed to the aggregate (post-anonymisation filter). */
  tenantCount: number;
  /** How many tenants were excluded for k-anonymity. */
  anonymisedTenantCount: number;
  /** Total base-currency volume the aggregate covers (cents). */
  totalVolumeBaseCents: number;
}

/**
 * Platform-wide volume-weighted aggregate. A platform whose only
 * non-anonymised tenant is a single A+ behemoth still produces an A+
 * platform grade; a platform with 100 small B-tenants and one A+
 * outlier sits in B.
 */
export async function computeMobilisationPlatformAggregate(
  period: MobilisationPeriod,
): Promise<MobilisationPlatformAggregate> {
  const tenants = await computeMobilisationPerTenant(period);

  let weightedScore = 0;
  let totalVolume = 0;
  let counted = 0;
  let anonymised = 0;

  for (const t of tenants) {
    if (t.result.isAnonymised || t.result.score === null) {
      anonymised++;
      continue;
    }
    weightedScore += t.result.score * t.volumeBaseCents;
    totalVolume += t.volumeBaseCents;
    counted++;
  }

  if (counted === 0 || totalVolume === 0) {
    return {
      score: null,
      grade: null,
      tenantCount: 0,
      anonymisedTenantCount: anonymised,
      totalVolumeBaseCents: 0,
    };
  }

  const score = weightedScore / totalVolume;
  // Re-derive the grade from the aggregate score — same bands.
  let grade: MobilisationResult["grade"];
  if (score >= 90) grade = "A+";
  else if (score >= 75) grade = "A";
  else if (score >= 60) grade = "B";
  else if (score >= 40) grade = "C";
  else grade = "D";

  return {
    score,
    grade,
    tenantCount: counted,
    anonymisedTenantCount: anonymised,
    totalVolumeBaseCents: totalVolume,
  };
}
