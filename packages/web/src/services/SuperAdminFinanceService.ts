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
  FinancePeriod,
  FinanceSummary,
  FinanceSummaryResponse,
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
};
