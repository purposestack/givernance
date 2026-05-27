/**
 * Super-admin finance dashboard service (Epic #434 / issue #206).
 *
 * Thin facade around the ApiClient that surfaces the two endpoints
 * the dashboard uses:
 *   - GET  /v1/superadmin/finance/summary
 *   - POST /v1/superadmin/surveys/:slug/launch
 *
 * Always-translated labels live in the consuming page — this service
 * is pure data plumbing (ADR-011 Layer 2).
 */

import type { ApiClient } from "@/lib/api";
import type {
  BackfillResponse,
  FinancePeriod,
  FinanceSummary,
  FinanceSummaryResponse,
  MonthlyReport,
  MonthlyReportResponse,
  SurveyLaunchResponse,
} from "@/models/superadmin-finance";

export interface FetchSummaryParams {
  period: FinancePeriod;
  from?: string;
  to?: string;
  currency?: "EUR" | "GBP" | "CHF" | "all";
  tenantId?: string;
}

export const SuperAdminFinanceService = {
  /**
   * Fetch the finance summary for the given period. The server caches
   * each (period, from, to, currency, tenantId) tuple for 5 minutes
   * (see `docs/30` / Epic #434), so frequent client-side switches are
   * cheap.
   */
  async fetchSummary(client: ApiClient, params: FetchSummaryParams): Promise<FinanceSummary> {
    const query: Record<string, string> = { period: params.period };
    if (params.from) query.from = params.from;
    if (params.to) query.to = params.to;
    if (params.currency) query.currency = params.currency;
    if (params.tenantId) query.tenantId = params.tenantId;
    const response = await client.get<FinanceSummaryResponse>("/v1/superadmin/finance/summary", {
      params: query,
    });
    return response.data;
  },

  /**
   * Build the absolute browser URL for the CSV export endpoint with the
   * current filters baked into the query string. Returns the URL string;
   * the caller triggers the download via `window.location.assign(...)`
   * (or an `<a download>` click). The endpoint streams `text/csv` with a
   * `Content-Disposition: attachment` header so the browser saves rather
   * than navigates. Issue #442.
   */
  buildSummaryCsvUrl(client: ApiClient, params: FetchSummaryParams): string {
    const query = new URLSearchParams({ period: params.period });
    if (params.from) query.set("from", params.from);
    if (params.to) query.set("to", params.to);
    if (params.currency) query.set("currency", params.currency);
    if (params.tenantId) query.set("tenantId", params.tenantId);
    return client.resolveBrowserUrl(`/v1/superadmin/finance/summary.csv?${query.toString()}`);
  },

  /**
   * Launch a survey campaign. The server enforces a 24h cooldown per
   * (survey, channel) — a 429 carries `Retry-After`. The
   * `Idempotency-Key` header MUST be a fresh UUID per attempt so a
   * retry-after-network-blip doesn't double-send invitations.
   */
  async launchSurvey(
    client: ApiClient,
    slug: string,
    body: { channel: "email" | "in_app" },
    idempotencyKey: string,
  ): Promise<SurveyLaunchResponse["data"]> {
    const response = await client.post<SurveyLaunchResponse>(
      `/v1/superadmin/surveys/${encodeURIComponent(slug)}/launch`,
      body,
      { headers: { "Idempotency-Key": idempotencyKey } },
    );
    return response.data;
  },

  /**
   * Force-flush the 5-minute Redis cache for the finance summary.
   * Rare-use operator action — surfaces fresh data after an out-of-
   * band SQL refresh (e.g. seed re-run). Server enforces rate-limit
   * (5/min/IP) + audits each call. Issue #449.
   */
  async flushCache(client: ApiClient): Promise<{ keysDeleted: number; pattern: string }> {
    const response = await client.post<{
      data: { keysDeleted: number; pattern: string };
    }>("/v1/superadmin/finance/cache/flush", {});
    return response.data;
  },

  /**
   * Request generation of the monthly platform finance report PDF
   * (issue #443). Idempotent on the target month — same-month replays
   * return the existing pending/ready row. Pass an explicit `month`
   * to re-run an older period; default is the most recent
   * fully-completed calendar month (server-resolved).
   */
  async requestMonthlyReport(
    client: ApiClient,
    body: { month?: string } = {},
  ): Promise<MonthlyReport> {
    const response = await client.post<MonthlyReportResponse>(
      "/v1/superadmin/finance/reports/monthly",
      body,
    );
    return response.data;
  },

  /** Poll the report's status until `ready` or `failed`. */
  async fetchReport(client: ApiClient, id: string): Promise<MonthlyReport> {
    const response = await client.get<MonthlyReportResponse>(
      `/v1/superadmin/finance/reports/${encodeURIComponent(id)}`,
    );
    return response.data;
  },

  /**
   * List the most recent monthly reports, one row per month (the API
   * deduplicates and prefers `ready` over `pending`/`failed`).
   */
  async listReports(client: ApiClient): Promise<MonthlyReport[]> {
    const response = await client.get<{ data: MonthlyReport[] }>("/v1/superadmin/finance/reports");
    return response.data;
  },

  /**
   * Regenerate an existing report — marks the source row as
   * superseded and enqueues a fresh PDF for the same month using
   * the current SQL + renderer. The old row stays in the system
   * for RGPD Art. 5.2 accountability.
   */
  async regenerateReport(
    client: ApiClient,
    id: string,
  ): Promise<{ newReport: MonthlyReport; supersededReport: MonthlyReport }> {
    const response = await client.post<{
      data: { newReport: MonthlyReport; supersededReport: MonthlyReport };
    }>(`/v1/superadmin/finance/reports/${encodeURIComponent(id)}/regenerate`, {});
    return response.data;
  },

  /**
   * Backfill — request reports for each of the last 12 fully-completed
   * months that doesn't yet have a live row. Idempotent; existing
   * pending/ready rows are reported as `skipped`. Rate-limited
   * server-side (2/min/IP).
   */
  async backfillReports(client: ApiClient): Promise<BackfillResponse["data"]> {
    const response = await client.post<BackfillResponse>(
      "/v1/superadmin/finance/reports/backfill",
      {},
    );
    return response.data;
  },
};
