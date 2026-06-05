// Mirror of packages/api/src/modules/superadmin/finance/mobilisation.ts.
// Copied here so the worker's cron-trigger processor can compute
// mobilisation scores without importing across package boundaries.
// Keep in sync with the API original when the scoring logic changes.

import {
  computeMobilisationScore,
  type MobilisationInput,
  type MobilisationResult,
} from "@givernance/shared";
import { sql } from "drizzle-orm";
import { db as systemDb } from "../../lib/db.js";

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
  input: MobilisationInput;
  volumeBaseCents: number;
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

  const activationRate = cohortSize > 0 ? uniqueDonorCount / cohortSize : 0;
  const recurringRevenueRatio = periodVolume > 0 ? Math.min(recurringMonthly / periodVolume, 1) : 0;
  const growthRate = previousVolume > 0 ? (periodVolume - previousVolume) / previousVolume : 0;
  const channelDiversity = hhi > 0 ? Math.max(0, 1 - hhi) : 0;

  return {
    input: {
      uniqueDonorCount,
      activationRate,
      recurringRevenueRatio,
      volumeBaseEur: periodVolume / 100,
      growthRate,
      channelDiversity,
    },
    volumeBaseCents: periodVolume,
  };
}

export interface ComputePerTenantOptions {
  tenantId?: string;
}

export async function computeMobilisationPerTenant(
  period: MobilisationPeriod,
  opts: ComputePerTenantOptions = {},
): Promise<TenantMobilisationRow[]> {
  const { from, to } = period;
  const periodMs = to.getTime() - from.getTime();
  const previousFrom = new Date(from.getTime() - periodMs);
  const previousTo = from;
  const monthsInPeriod = Math.max(periodMs / (1000 * 60 * 60 * 24 * 30.44), 0.01);
  const tenantFilter = opts.tenantId ? sql`AND t.id = ${opts.tenantId}::uuid` : sql``;

  const result = await systemDb.execute<RawRow>(sql`
    WITH
    cohort AS (
      SELECT d.org_id, COUNT(DISTINCT d.constituent_id) AS cohort_size
      FROM donations d WHERE d.status = 'cleared' GROUP BY d.org_id
    ),
    period_revenue AS (
      SELECT d.org_id,
        COALESCE(SUM(d.amount_base_cents), 0) AS period_volume_base_cents,
        COUNT(DISTINCT d.constituent_id) AS unique_donor_count
      FROM donations d
      WHERE d.status = 'cleared' AND d.donated_at >= ${from} AND d.donated_at < ${to}
      GROUP BY d.org_id
    ),
    previous_revenue AS (
      SELECT d.org_id, COALESCE(SUM(d.amount_base_cents), 0) AS previous_volume_base_cents
      FROM donations d
      WHERE d.status = 'cleared' AND d.donated_at >= ${previousFrom} AND d.donated_at < ${previousTo}
      GROUP BY d.org_id
    ),
    recurring_revenue AS (
      SELECT p.org_id,
        COALESCE(SUM(CASE p.frequency WHEN 'monthly' THEN p.amount_base_cents::numeric
          WHEN 'yearly' THEN p.amount_base_cents::numeric / 12 ELSE 0 END), 0) AS monthly_base_cents
      FROM pledges p WHERE p.status = 'active' GROUP BY p.org_id
    ),
    channel_shares AS (
      SELECT org_id, payment_source,
        SUM(amount_base_cents)::numeric AS source_volume,
        SUM(SUM(amount_base_cents)) OVER (PARTITION BY org_id)::numeric AS org_total
      FROM donations WHERE status = 'cleared' AND donated_at >= ${from} AND donated_at < ${to}
      GROUP BY org_id, payment_source
    ),
    channel_hhi AS (
      SELECT org_id, SUM(POW(source_volume / NULLIF(org_total, 0), 2))::numeric AS channel_hhi
      FROM channel_shares GROUP BY org_id
    )
    SELECT
      t.id AS org_id, t.name AS tenant_name, t.status AS tenant_status,
      COALESCE(pr.unique_donor_count, 0) AS unique_donor_count,
      COALESCE(c.cohort_size, 0) AS cohort_size,
      COALESCE(pr.period_volume_base_cents, 0) AS period_volume_base_cents,
      COALESCE(rr.monthly_base_cents * ${monthsInPeriod}, 0) AS recurring_monthly_base_cents,
      COALESCE(prv.previous_volume_base_cents, 0) AS previous_volume_base_cents,
      ch.channel_hhi AS channel_hhi
    FROM tenants t
    LEFT JOIN cohort c ON c.org_id = t.id
    LEFT JOIN period_revenue pr ON pr.org_id = t.id
    LEFT JOIN previous_revenue prv ON prv.org_id = t.id
    LEFT JOIN recurring_revenue rr ON rr.org_id = t.id
    LEFT JOIN channel_hhi ch ON ch.org_id = t.id
    WHERE t.status NOT IN ('archived', 'suspended') ${tenantFilter}
    ORDER BY t.name ASC
  `);

  return (result.rows as RawRow[]).map((row) => {
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
  score: number | null;
  grade: MobilisationResult["grade"];
  tenantCount: number;
  anonymisedTenantCount: number;
  totalVolumeBaseCents: number;
}

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
