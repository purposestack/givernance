// Mirror of packages/api/src/modules/superadmin/finance/service.ts.
// Copied here so the worker's cron-trigger processor can build the
// kpi_snapshot without importing across package boundaries.
// Keep in sync with the API original when the aggregation logic changes.

import { sql } from "drizzle-orm";
import { db as systemDb } from "../../lib/db.js";
import {
  computeMobilisationPerTenant,
  computeMobilisationPlatformAggregate,
} from "./mobilisation.js";
import { deltaPercent, type ResolvedPeriod } from "./period.js";

const K_ANONYMITY_THRESHOLD = 5;

interface KpiRow extends Record<string, unknown> {
  volume_cents: string | number | null;
  platform_fee_cents: string | number | null;
  stripe_fee_cents: string | number | null;
  donor_count: string | number | null;
  refunded_volume_cents: string | number | null;
  any_stripe_donation: boolean | null;
}

interface FailureRow extends Record<string, unknown> {
  attempts: string | number;
  failures: string | number;
}

interface MrrRow extends Record<string, unknown> {
  recurring_mrr_cents: string | number | null;
}

interface ActiveTenantsRow extends Record<string, unknown> {
  active_count: string | number;
}

interface HhiRow extends Record<string, unknown> {
  hhi: string | number | null;
}

interface TimeseriesRow extends Record<string, unknown> {
  bucket: Date;
  volume_cents: string | number | null;
  platform_fee_cents: string | number | null;
}

interface PerTenantRow extends Record<string, unknown> {
  tenant_id: string;
  tenant_name: string;
  volume_cents: string | number | null;
  platform_fee_cents: string | number | null;
  donation_count: string | number;
}

interface PerCurrencyRow extends Record<string, unknown> {
  currency: string;
  volume_cents: string | number | null;
  donation_count: string | number;
}

interface SurveyRow extends Record<string, unknown> {
  id: string;
  kind: string;
  slug: string;
  next_scheduled_at: Date | null;
  invited_count: string | number;
}

interface SurveyAggregateRow extends Record<string, unknown> {
  survey_id: string;
  response_count: string | number;
  pmf_percent: string | number | null;
  nps_score: string | number | null;
  csat_score: string | number | null;
  last_collected_at: Date | null;
}

function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : Number.parseFloat(value);
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toInt(value: string | number | null | undefined): number {
  return Math.round(toNumber(value));
}

export interface SummaryFilters {
  currency?: "EUR" | "GBP" | "CHF" | "all";
  tenantId?: string;
}

export interface SummaryInput {
  period: ResolvedPeriod;
  filters: SummaryFilters;
}

export interface SummaryServiceResult {
  period: {
    from: string;
    to: string;
    label: string;
    comparisonFrom: string;
    comparisonTo: string;
  };
  kpis: {
    volumeCents: number;
    platformFeeCents: number;
    stripeFeeCents: number | null;
    donorCount: number;
    refundedVolumeCents: number;
    recurringMrrCents: number;
    activeTenantsCount: number;
    paymentFailureRate: number | null;
    hhi: number;
    deltas: {
      volumePercent: number;
      platformFeePercent: number;
      stripeFeePercent: number | null;
      donorCountPercent: number;
      refundedVolumePercent: number;
      recurringMrrPercent: number;
    };
  };
  mobilisation: {
    platformGrade: "A+" | "A" | "B" | "C" | "D" | null;
    platformScore: number | null;
    components: {
      activation: number;
      recurrence: number;
      scale: number;
      growth: number;
      diversity: number;
    };
    perTenant: Array<{
      tenantId: string;
      tenantName: string;
      grade: "A+" | "A" | "B" | "C" | "D" | null;
      score: number | null;
      components: {
        activation: number;
        recurrence: number;
        scale: number;
        growth: number;
        diversity: number;
      };
      isAnonymised: boolean;
    }>;
  };
  surveys: Array<{
    kind: "pmf" | "nps" | "csat";
    slug: string;
    lastCollectedAt: string | null;
    nextScheduledAt: string | null;
    responseCount: number;
    invitedCount: number;
    pmfPercent: number | null;
    npsScore: number | null;
    csatScore: number | null;
    isStatisticallySignificant: boolean;
  }>;
  timeseries: Array<{ date: string; volumeCents: number; platformFeeCents: number }>;
  perTenant: Array<{
    tenantId: string;
    tenantName: string;
    volumeCents: number;
    platformFeeCents: number;
    donationCount: number;
  }>;
  perCurrency: Array<{ currency: string; volumeCents: number; donationCount: number }>;
}

async function aggregateKpis(
  from: Date,
  to: Date,
  filters: SummaryFilters,
): Promise<{
  volumeCents: number;
  platformFeeCents: number;
  stripeFeeCents: number | null;
  donorCount: number;
  refundedVolumeCents: number;
}> {
  const currencyFilter =
    filters.currency && filters.currency !== "all"
      ? sql`AND d.currency = ${filters.currency}`
      : sql``;
  const tenantFilter = filters.tenantId ? sql`AND d.org_id = ${filters.tenantId}::uuid` : sql``;

  const rows = await systemDb.execute<KpiRow>(sql`
    SELECT
      COALESCE(SUM(d.amount_base_cents) FILTER (WHERE d.status = 'cleared'), 0) AS volume_cents,
      COALESCE(SUM(d.platform_fee_base_cents) FILTER (WHERE d.status = 'cleared'), 0) AS platform_fee_cents,
      COALESCE(SUM(d.stripe_fee_cents) FILTER (WHERE d.status = 'cleared' AND d.payment_source = 'stripe'), 0) AS stripe_fee_cents,
      COUNT(DISTINCT d.constituent_id) FILTER (WHERE d.status = 'cleared') AS donor_count,
      COALESCE(SUM(d.amount_base_cents) FILTER (WHERE d.refunded_at IS NOT NULL AND d.refunded_at >= ${from} AND d.refunded_at < ${to}), 0) AS refunded_volume_cents,
      BOOL_OR(d.status = 'cleared' AND d.payment_source = 'stripe' AND d.stripe_fee_cents IS NOT NULL) AS any_stripe_donation
    FROM donations d
    JOIN tenants t ON t.id = d.org_id
    WHERE d.donated_at >= ${from} AND d.donated_at < ${to}
      AND t.status NOT IN ('archived', 'suspended')
      ${currencyFilter} ${tenantFilter}
  `);

  const row = rows.rows[0];
  return {
    volumeCents: toInt(row?.volume_cents),
    platformFeeCents: toInt(row?.platform_fee_cents),
    stripeFeeCents: row?.any_stripe_donation ? toInt(row?.stripe_fee_cents) : null,
    donorCount: toInt(row?.donor_count),
    refundedVolumeCents: toInt(row?.refunded_volume_cents),
  };
}

async function aggregateRecurringMrr(filters: SummaryFilters): Promise<number> {
  const tenantFilter = filters.tenantId ? sql`AND p.org_id = ${filters.tenantId}::uuid` : sql``;
  const rows = await systemDb.execute<MrrRow>(sql`
    SELECT COALESCE(SUM(CASE p.frequency WHEN 'monthly' THEN p.amount_base_cents::numeric
      WHEN 'yearly' THEN p.amount_base_cents::numeric / 12 ELSE 0 END), 0) AS recurring_mrr_cents
    FROM pledges p
    JOIN tenants t ON t.id = p.org_id
    WHERE p.status = 'active' AND t.status NOT IN ('archived', 'suspended') ${tenantFilter}
  `);
  return toInt(rows.rows[0]?.recurring_mrr_cents);
}

async function aggregateActiveTenants(
  from: Date,
  to: Date,
  filters: SummaryFilters,
): Promise<number> {
  const currencyFilter =
    filters.currency && filters.currency !== "all"
      ? sql`AND d.currency = ${filters.currency}`
      : sql``;
  const tenantFilter = filters.tenantId ? sql`AND d.org_id = ${filters.tenantId}::uuid` : sql``;
  const rows = await systemDb.execute<ActiveTenantsRow>(sql`
    SELECT COUNT(DISTINCT d.org_id) AS active_count
    FROM donations d
    JOIN tenants t ON t.id = d.org_id
    WHERE d.status = 'cleared' AND d.donated_at >= ${from} AND d.donated_at < ${to}
      AND t.status NOT IN ('archived', 'suspended') ${currencyFilter} ${tenantFilter}
  `);
  return toInt(rows.rows[0]?.active_count);
}

async function aggregatePaymentFailureRate(
  from: Date,
  to: Date,
  filters: SummaryFilters,
): Promise<number | null> {
  const tenantFilter = filters.tenantId ? sql`AND pa.org_id = ${filters.tenantId}::uuid` : sql``;
  const rows = await systemDb.execute<FailureRow>(sql`
    SELECT COUNT(*) AS attempts, COUNT(*) FILTER (WHERE pa.status = 'failed') AS failures
    FROM payment_attempts pa
    JOIN tenants t ON t.id = pa.org_id
    WHERE pa.created_at >= ${from} AND pa.created_at < ${to}
      AND t.status NOT IN ('archived', 'suspended') ${tenantFilter}
  `);
  const attempts = toInt(rows.rows[0]?.attempts);
  const failures = toInt(rows.rows[0]?.failures);
  if (attempts === 0) return null;
  return (failures / attempts) * 100;
}

async function aggregateHhi(from: Date, to: Date, filters: SummaryFilters): Promise<number> {
  const currencyFilter =
    filters.currency && filters.currency !== "all"
      ? sql`AND d.currency = ${filters.currency}`
      : sql``;
  const tenantFilter = filters.tenantId ? sql`AND d.org_id = ${filters.tenantId}::uuid` : sql``;
  const rows = await systemDb.execute<HhiRow>(sql`
    WITH shares AS (
      SELECT d.org_id, SUM(d.amount_base_cents)::numeric AS org_volume
      FROM donations d JOIN tenants t ON t.id = d.org_id
      WHERE d.status = 'cleared' AND d.donated_at >= ${from} AND d.donated_at < ${to}
        AND t.status NOT IN ('archived', 'suspended') ${currencyFilter} ${tenantFilter}
      GROUP BY d.org_id
    ),
    total AS (SELECT SUM(org_volume) AS platform_volume FROM shares)
    SELECT COALESCE(SUM(POW(org_volume / NULLIF((SELECT platform_volume FROM total), 0), 2)), 0) AS hhi
    FROM shares
  `);
  return toNumber(rows.rows[0]?.hhi);
}

async function aggregateTimeseries(
  from: Date,
  to: Date,
  filters: SummaryFilters,
): Promise<Array<{ date: string; volumeCents: number; platformFeeCents: number }>> {
  const currencyFilter =
    filters.currency && filters.currency !== "all"
      ? sql`AND d.currency = ${filters.currency}`
      : sql``;
  const tenantFilter = filters.tenantId ? sql`AND d.org_id = ${filters.tenantId}::uuid` : sql``;
  const rows = await systemDb.execute<TimeseriesRow>(sql`
    SELECT date_trunc('day', d.donated_at) AS bucket,
      COALESCE(SUM(d.amount_base_cents), 0) AS volume_cents,
      COALESCE(SUM(d.platform_fee_base_cents), 0) AS platform_fee_cents
    FROM donations d JOIN tenants t ON t.id = d.org_id
    WHERE d.status = 'cleared' AND d.donated_at >= ${from} AND d.donated_at < ${to}
      AND t.status NOT IN ('archived', 'suspended') ${currencyFilter} ${tenantFilter}
    GROUP BY bucket ORDER BY bucket ASC
  `);
  return rows.rows.map((row) => {
    const bucket = row.bucket instanceof Date ? row.bucket : new Date(String(row.bucket));
    return {
      date: bucket.toISOString().slice(0, 10),
      volumeCents: toInt(row.volume_cents),
      platformFeeCents: toInt(row.platform_fee_cents),
    };
  });
}

async function aggregatePerTenant(
  from: Date,
  to: Date,
  filters: SummaryFilters,
): Promise<
  Array<{
    tenantId: string;
    tenantName: string;
    volumeCents: number;
    platformFeeCents: number;
    donationCount: number;
  }>
> {
  const currencyFilter =
    filters.currency && filters.currency !== "all"
      ? sql`AND d.currency = ${filters.currency}`
      : sql``;
  const tenantFilter = filters.tenantId ? sql`AND d.org_id = ${filters.tenantId}::uuid` : sql``;
  const rows = await systemDb.execute<PerTenantRow>(sql`
    SELECT t.id AS tenant_id, t.name AS tenant_name,
      COALESCE(SUM(d.amount_base_cents), 0) AS volume_cents,
      COALESCE(SUM(d.platform_fee_base_cents), 0) AS platform_fee_cents,
      COUNT(d.id) AS donation_count
    FROM tenants t JOIN donations d ON d.org_id = t.id
    WHERE d.status = 'cleared' AND d.donated_at >= ${from} AND d.donated_at < ${to}
      AND t.status NOT IN ('archived', 'suspended') ${currencyFilter} ${tenantFilter}
    GROUP BY t.id, t.name ORDER BY volume_cents DESC
  `);
  return rows.rows
    .filter((row) => toInt(row.donation_count) >= K_ANONYMITY_THRESHOLD)
    .map((row) => ({
      tenantId: row.tenant_id,
      tenantName: row.tenant_name,
      volumeCents: toInt(row.volume_cents),
      platformFeeCents: toInt(row.platform_fee_cents),
      donationCount: toInt(row.donation_count),
    }));
}

async function aggregatePerCurrency(
  from: Date,
  to: Date,
  filters: SummaryFilters,
): Promise<Array<{ currency: string; volumeCents: number; donationCount: number }>> {
  const tenantFilter = filters.tenantId ? sql`AND d.org_id = ${filters.tenantId}::uuid` : sql``;
  const rows = await systemDb.execute<PerCurrencyRow>(sql`
    SELECT d.currency,
      COALESCE(SUM(d.amount_base_cents), 0) AS volume_cents,
      COUNT(d.id) AS donation_count
    FROM donations d JOIN tenants t ON t.id = d.org_id
    WHERE d.status = 'cleared' AND d.donated_at >= ${from} AND d.donated_at < ${to}
      AND t.status NOT IN ('archived', 'suspended') ${tenantFilter}
    GROUP BY d.currency ORDER BY volume_cents DESC
  `);
  return rows.rows.map((row) => ({
    currency: row.currency,
    volumeCents: toInt(row.volume_cents),
    donationCount: toInt(row.donation_count),
  }));
}

async function aggregateSurveys(filters: SummaryFilters): Promise<
  Array<{
    kind: "pmf" | "nps" | "csat";
    slug: string;
    lastCollectedAt: string | null;
    nextScheduledAt: string | null;
    responseCount: number;
    invitedCount: number;
    pmfPercent: number | null;
    npsScore: number | null;
    csatScore: number | null;
    isStatisticallySignificant: boolean;
  }>
> {
  const tenantFilter = filters.tenantId ? sql`AND i.org_id = ${filters.tenantId}::uuid` : sql``;

  const surveyRows = await systemDb.execute<SurveyRow>(sql`
    SELECT s.id, s.kind, s.slug, s.next_scheduled_at,
      COALESCE(invited.invited_count, 0) AS invited_count
    FROM surveys s
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS invited_count FROM survey_invitations i
      WHERE i.survey_id = s.id AND i.deleted_at IS NULL ${tenantFilter}
    ) invited ON TRUE
    WHERE s.deleted_at IS NULL AND s.kind IN ('pmf', 'nps', 'csat')
    ORDER BY s.kind ASC, s.slug ASC
  `);

  if (surveyRows.rows.length === 0) return [];

  const aggregateRows = await systemDb.execute<SurveyAggregateRow>(sql`
    SELECT survey_id,
      SUM(response_count)::int AS response_count,
      AVG(pmf_percent) AS pmf_percent,
      AVG(nps_score) AS nps_score,
      AVG(csat_score) AS csat_score,
      MAX(last_collected_at) AS last_collected_at
    FROM survey_responses_aggregate
    ${filters.tenantId ? sql`WHERE org_id = ${filters.tenantId}::uuid` : sql``}
    GROUP BY survey_id
  `);

  const aggregateBySurveyId = new Map<string, SurveyAggregateRow>();
  for (const row of aggregateRows.rows) {
    aggregateBySurveyId.set(row.survey_id, row);
  }

  return surveyRows.rows
    .filter((row): row is SurveyRow & { kind: "pmf" | "nps" | "csat" } =>
      ["pmf", "nps", "csat"].includes(row.kind),
    )
    .map((row) => {
      const agg = aggregateBySurveyId.get(row.id);
      const responseCount = toInt(agg?.response_count);
      const isStatisticallySignificant = responseCount >= K_ANONYMITY_THRESHOLD;
      return {
        kind: row.kind,
        slug: row.slug,
        lastCollectedAt: toIso(agg?.last_collected_at),
        nextScheduledAt: toIso(row.next_scheduled_at),
        responseCount,
        invitedCount: toInt(row.invited_count),
        pmfPercent:
          isStatisticallySignificant && agg?.pmf_percent != null ? toNumber(agg.pmf_percent) : null,
        npsScore:
          isStatisticallySignificant && agg?.nps_score != null ? toNumber(agg.nps_score) : null,
        csatScore:
          isStatisticallySignificant && agg?.csat_score != null ? toNumber(agg.csat_score) : null,
        isStatisticallySignificant,
      };
    });
}

export async function buildFinanceSummary(input: SummaryInput): Promise<SummaryServiceResult> {
  const { period, filters } = input;

  const [
    currentKpis,
    previousKpis,
    recurringMrr,
    activeTenants,
    failureRate,
    hhi,
    timeseries,
    perTenant,
    perCurrency,
    surveys,
    mobilisationRows,
    mobilisationAggregate,
  ] = await Promise.all([
    aggregateKpis(period.from, period.to, filters),
    aggregateKpis(period.comparisonFrom, period.comparisonTo, filters),
    aggregateRecurringMrr(filters),
    aggregateActiveTenants(period.from, period.to, filters),
    aggregatePaymentFailureRate(period.from, period.to, filters),
    aggregateHhi(period.from, period.to, filters),
    aggregateTimeseries(period.from, period.to, filters),
    aggregatePerTenant(period.from, period.to, filters),
    aggregatePerCurrency(period.from, period.to, filters),
    aggregateSurveys(filters),
    computeMobilisationPerTenant(
      { from: period.from, to: period.to },
      filters.tenantId ? { tenantId: filters.tenantId } : {},
    ),
    computeMobilisationPlatformAggregate({ from: period.from, to: period.to }),
  ]);

  const componentTotals = mobilisationRows.reduce(
    (acc, row) => {
      if (row.result.isAnonymised) return acc;
      acc.activation += row.result.components.activation;
      acc.recurrence += row.result.components.recurrence;
      acc.scale += row.result.components.scale;
      acc.growth += row.result.components.growth;
      acc.diversity += row.result.components.diversity;
      acc.count += 1;
      return acc;
    },
    { activation: 0, recurrence: 0, scale: 0, growth: 0, diversity: 0, count: 0 },
  );
  const platformComponents = {
    activation: componentTotals.count > 0 ? componentTotals.activation / componentTotals.count : 0,
    recurrence: componentTotals.count > 0 ? componentTotals.recurrence / componentTotals.count : 0,
    scale: componentTotals.count > 0 ? componentTotals.scale / componentTotals.count : 0,
    growth: componentTotals.count > 0 ? componentTotals.growth / componentTotals.count : 0,
    diversity: componentTotals.count > 0 ? componentTotals.diversity / componentTotals.count : 0,
  };

  return {
    period: {
      from: period.from.toISOString(),
      to: period.to.toISOString(),
      label: period.label,
      comparisonFrom: period.comparisonFrom.toISOString(),
      comparisonTo: period.comparisonTo.toISOString(),
    },
    kpis: {
      volumeCents: currentKpis.volumeCents,
      platformFeeCents: currentKpis.platformFeeCents,
      stripeFeeCents: currentKpis.stripeFeeCents,
      donorCount: currentKpis.donorCount,
      refundedVolumeCents: currentKpis.refundedVolumeCents,
      recurringMrrCents: recurringMrr,
      activeTenantsCount: activeTenants,
      paymentFailureRate: failureRate,
      hhi,
      deltas: {
        volumePercent: deltaPercent(currentKpis.volumeCents, previousKpis.volumeCents),
        platformFeePercent: deltaPercent(
          currentKpis.platformFeeCents,
          previousKpis.platformFeeCents,
        ),
        stripeFeePercent:
          currentKpis.stripeFeeCents === null || previousKpis.stripeFeeCents === null
            ? null
            : deltaPercent(currentKpis.stripeFeeCents, previousKpis.stripeFeeCents),
        donorCountPercent: deltaPercent(currentKpis.donorCount, previousKpis.donorCount),
        refundedVolumePercent: deltaPercent(
          currentKpis.refundedVolumeCents,
          previousKpis.refundedVolumeCents,
        ),
        recurringMrrPercent: 0,
      },
    },
    mobilisation: {
      platformGrade: mobilisationAggregate.grade,
      platformScore: mobilisationAggregate.score,
      components: platformComponents,
      perTenant: mobilisationRows.map((row) => ({
        tenantId: row.orgId,
        tenantName: row.tenantName,
        grade: row.result.grade,
        score: row.result.score,
        components: row.result.components,
        isAnonymised: row.result.isAnonymised,
      })),
    },
    surveys,
    timeseries,
    perTenant,
    perCurrency,
  };
}
