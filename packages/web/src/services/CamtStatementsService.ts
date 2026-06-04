/**
 * CamtStatementsService — frontend bindings for the camt.053 reconciliation
 * endpoints (Epic #318 PR #5).
 *
 * Mirrors `packages/api/src/modules/camt-statements/routes.ts`. Same pattern
 * as PostalCampaignService / BankAccountService (ADR-011 Layer 2): thin
 * adapter over the typed ApiClient that maps responses to the frontend
 * models below.
 *
 * The upload endpoint takes a multipart body; the typed ApiClient detects
 * `FormData` and skips the JSON Content-Type so the browser-set
 * `multipart/form-data; boundary=…` survives.
 */

import type { ApiClient } from "@/lib/api";
import { ApiProblem } from "@/lib/api";

// ─── Types ──────────────────────────────────────────────────────────────

export type CamtStatementStatus = "pending" | "processing" | "processed" | "failed";

export type CamtUnreconciledReason =
  | "invalid_ref"
  | "no_match"
  | "no_debtor_info"
  | "orphan_reversal"
  | "partial_match";

export type CamtUnreconciledStatus = "pending" | "resolved" | "written_off";

export type CamtUnreconciledResolveAction =
  | "link"
  | "create_constituent_and_donation"
  | "write_off";

export interface Pagination {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

export interface CamtStatementSummary {
  id: string;
  msgId: string | null;
  bankAccountId: string;
  status: CamtStatementStatus;
  uploadedAt: string;
  processedAt: string | null;
  totalCredits: number;
  matchedCredits: number;
  unmatchedCredits: number;
  statementFrom: string | null;
  statementTo: string | null;
  originalFilename: string | null;
  error: string | null;
}

export interface CamtStatementDetail extends CamtStatementSummary {
  bankAccount: {
    id: string;
    iban: string;
    bankName: string;
    currency: string;
  } | null;
  creditEntryCount: number;
  unreconciledCount: number;
}

export interface ReconciliationHealth {
  totalStatements: number;
  lastStatementImportedAt: string | null;
  totalCreditsLastN: number;
  matchedCreditsLastN: number;
  unmatchedCreditsLastN: number;
  totalUnreconciledPending: number;
  recentStatements: CamtStatementSummary[];
}

export interface CamtUnreconciledRow {
  id: string;
  creditEntryId: string;
  reason: CamtUnreconciledReason;
  status: CamtUnreconciledStatus;
  resolvedAt: string | null;
  resolutionNote: string | null;
  linkedDonationId: string | null;
  createdAt: string;
  creditEntry: {
    statementId: string;
    statementMsgId: string | null;
    amountCents: number;
    currency: string;
    structuredRef: string | null;
    debtorName: string | null;
    debtorIban: string | null;
    bankAccountId: string;
    valueDate: string | null;
  };
}

export interface CamtStatementListQuery {
  bankAccountId?: string;
  status?: CamtStatementStatus;
  page?: number;
  perPage?: number;
}

export interface CamtUnreconciledListQuery {
  bankAccountId?: string;
  reason?: CamtUnreconciledReason;
  status?: CamtUnreconciledStatus;
  page?: number;
  perPage?: number;
}

export interface ResolveInput {
  action: CamtUnreconciledResolveAction;
  resolutionNote: string;
  donationId?: string;
  constituentId?: string;
}

// ─── Service ────────────────────────────────────────────────────────────

export const CamtStatementsService = {
  /**
   * Operator card on the bank-account detail page — 90-day aggregates of
   * imported statements, matched/unmatched counts, and the pending
   * unreconciled backlog. The 5 most-recent statements ride along so the
   * card can render the recent-list inline.
   */
  async getReconciliationHealth(
    client: ApiClient,
    bankAccountId: string,
  ): Promise<ReconciliationHealth | null> {
    try {
      const response = await client.get<{ data: ReconciliationHealth }>(
        `/v1/bank-accounts/${encodeURIComponent(bankAccountId)}/reconciliation-health`,
      );
      return response.data;
    } catch (err) {
      if (err instanceof ApiProblem && err.status === 404) return null;
      throw err;
    }
  },

  /**
   * Upload a camt.053 XML statement. The API validates content-type,
   * filename suffix and size cap (50 MB) before enqueueing the worker
   * import + reconcile passes; on success the response carries a
   * `statementId` the poller binds to.
   */
  async uploadStatement(
    client: ApiClient,
    bankAccountId: string,
    file: File,
  ): Promise<{ statementId: string; status: "pending" }> {
    const fd = new FormData();
    fd.append("file", file);
    const response = await client.post<{
      data: { statementId: string; status: "pending" };
    }>(`/v1/bank-accounts/${encodeURIComponent(bankAccountId)}/statements`, fd);
    return response.data;
  },

  async listStatements(
    client: ApiClient,
    query: CamtStatementListQuery = {},
  ): Promise<{ data: CamtStatementSummary[]; pagination: Pagination }> {
    const response = await client.get<{
      data: CamtStatementSummary[];
      pagination: Pagination;
    }>("/v1/camt-statements", {
      params: {
        page: query.page,
        perPage: query.perPage,
        bankAccountId: query.bankAccountId,
        status: query.status,
      },
    });
    return response;
  },

  async getStatement(client: ApiClient, id: string): Promise<CamtStatementDetail | null> {
    try {
      const response = await client.get<{ data: CamtStatementDetail }>(
        `/v1/camt-statements/${encodeURIComponent(id)}`,
      );
      return response.data;
    } catch (err) {
      if (err instanceof ApiProblem && err.status === 404) return null;
      throw err;
    }
  },

  /**
   * Resolve the absolute browser URL that streams the raw camt.053 XML.
   * The endpoint returns a 302 to a short-lived signed bucket URL — we
   * give the caller the API path so `window.open(url)` follows it
   * through the existing /api proxy + cookie domain (no presigned URL
   * leaks into the browser).
   */
  getStatementDownloadUrl(client: ApiClient, id: string): string {
    return client.resolveBrowserUrl(`/v1/camt-statements/${encodeURIComponent(id)}/download`);
  },

  async listUnreconciled(
    client: ApiClient,
    query: CamtUnreconciledListQuery = {},
  ): Promise<{ data: CamtUnreconciledRow[]; pagination: Pagination }> {
    const response = await client.get<{
      data: CamtUnreconciledRow[];
      pagination: Pagination;
    }>("/v1/camt-unreconciled", {
      params: {
        page: query.page,
        perPage: query.perPage,
        bankAccountId: query.bankAccountId,
        reason: query.reason,
        status: query.status,
      },
    });
    return response;
  },

  async resolveUnreconciled(
    client: ApiClient,
    id: string,
    payload: ResolveInput,
  ): Promise<CamtUnreconciledRow> {
    const response = await client.post<{ data: CamtUnreconciledRow }>(
      `/v1/camt-unreconciled/${encodeURIComponent(id)}/resolve`,
      payload,
    );
    return response.data;
  },
};

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Mask an IBAN per docs/25 §7 GDPR posture: render as `CH···· ·NN9·N` with
 * the country code, ellipsis filler, and the last 4 digits visible. The
 * UI uses this everywhere a debtor IBAN, statement IBAN, or unreconciled
 * IBAN is shown — full IBAN only on the bank-account form itself.
 */
export function maskIban(iban: string | null | undefined): string {
  if (!iban) return "—";
  const cleaned = iban.replace(/\s+/g, "");
  if (cleaned.length < 6) return "•••";
  const country = cleaned.slice(0, 2);
  const last4 = cleaned.slice(-4);
  return `${country}•••${last4}`;
}

/**
 * Parse a structured error string of shape `code:message` (per docs/25
 * §5.4.bis) into the discriminator + free-text. Falls back gracefully
 * when the server sent a plain string without the prefix.
 */
export function parseStatementError(
  error: string | null,
): { code: string | null; message: string } | null {
  if (!error) return null;
  const idx = error.indexOf(":");
  if (idx < 0) return { code: null, message: error };
  return {
    code: error.slice(0, idx).trim(),
    message: error.slice(idx + 1).trim(),
  };
}
