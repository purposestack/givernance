/**
 * Frontend type boundary for the super-admin finance dashboard
 * (Epic #434, issue #206). Per ADR-013, the web package never
 * imports Drizzle types or `packages/api` internals — we hand-write
 * the response shape here, mirroring the TypeBox `SummaryResponse`
 * locked in `packages/api/src/modules/superadmin/finance/schemas.ts`.
 *
 * If the API schema changes, change this file in the same PR (the
 * integration test `finance.summary.test.ts` is the canonical source
 * of truth for the wire shape).
 */

export type FinancePeriod = "today" | "7d" | "30d" | "90d" | "ytd" | "custom";

export type FinanceCurrency = "EUR" | "GBP" | "CHF" | "all";

export type FinanceGrade = "A+" | "A" | "B" | "C" | "D";

export type SurveyKind = "pmf" | "nps" | "csat";

export interface MobilisationComponents {
  activation: number;
  recurrence: number;
  scale: number;
  growth: number;
  diversity: number;
}

export interface FinanceDeltas {
  volumePercent: number;
  platformFeePercent: number;
  stripeFeePercent: number | null;
  donorCountPercent: number;
  refundedVolumePercent: number;
  recurringMrrPercent: number;
}

export interface FinanceKpis {
  volumeCents: number;
  platformFeeCents: number;
  stripeFeeCents: number | null;
  donorCount: number;
  refundedVolumeCents: number;
  recurringMrrCents: number;
  activeTenantsCount: number;
  paymentFailureRate: number | null;
  hhi: number;
  deltas: FinanceDeltas;
}

export interface MobilisationPerTenantRow {
  tenantId: string;
  tenantName: string;
  grade: FinanceGrade | null;
  score: number | null;
  components: MobilisationComponents;
  isAnonymised: boolean;
}

export interface Mobilisation {
  platformGrade: FinanceGrade | null;
  platformScore: number | null;
  components: MobilisationComponents;
  perTenant: MobilisationPerTenantRow[];
}

export interface SurveyRow {
  kind: SurveyKind;
  slug: string;
  lastCollectedAt: string | null;
  nextScheduledAt: string | null;
  responseCount: number;
  invitedCount: number;
  pmfPercent: number | null;
  npsScore: number | null;
  csatScore: number | null;
  isStatisticallySignificant: boolean;
}

export interface TimeseriesPoint {
  date: string;
  volumeCents: number;
  platformFeeCents: number;
}

export interface PerTenantRow {
  tenantId: string;
  tenantName: string;
  volumeCents: number;
  platformFeeCents: number;
  donationCount: number;
}

export interface PerCurrencyRow {
  currency: string;
  volumeCents: number;
  donationCount: number;
}

export interface PeriodWindow {
  from: string;
  to: string;
  label: string;
  comparisonFrom: string;
  comparisonTo: string;
}

export interface FinanceSummary {
  period: PeriodWindow;
  kpis: FinanceKpis;
  mobilisation: Mobilisation;
  surveys: SurveyRow[];
  timeseries: TimeseriesPoint[];
  perTenant: PerTenantRow[];
  perCurrency: PerCurrencyRow[];
}

export interface FinanceSummaryResponse {
  data: FinanceSummary;
}

export interface SurveyLaunchResponse {
  data: {
    launchId: string;
    surveyId: string;
    channel: "email" | "in_app";
    recipientCount: number;
    launchedAt: string;
  };
}

// ─── Monthly platform finance report (issue #443) ──────────────────────────

export type MonthlyReportStatus = "pending" | "ready" | "failed";

export interface MonthlyReport {
  id: string;
  /** YYYY-MM */
  month: string;
  status: MonthlyReportStatus;
  failureReason: string | null;
  createdAt: string;
  readyAt: string | null;
  /** Path-relative URL of the streamed PDF (null until status='ready'). */
  pdfUrl: string | null;
}

export interface MonthlyReportResponse {
  data: MonthlyReport;
}
