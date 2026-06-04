/**
 * camt-statements service (Epic #318 PR #5).
 *
 * Owns the read-side queries that drive:
 *   - `GET /v1/camt-statements` (list, paginated, filterable)
 *   - `GET /v1/camt-statements/:id` (detail with credit-entry counts)
 *   - `GET /v1/camt-statements/:id/download` (signed URL prep)
 *   - `GET /v1/bank-accounts/:id/reconciliation-health` (operator card)
 *
 * The upload + outbox emit lives in `upload-service.ts` so the data
 * boundary stays clean (this file is read-only, that one mutates).
 */

import {
  type BankAccount,
  bankAccounts,
  type CamtStatementStatus,
  camtCreditEntries,
  camtStatements,
  camtUnreconciledEntries,
} from "@givernance/shared/schema";
import type { Pagination } from "@givernance/shared/types";
import { and, count, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { withTenantContext } from "../../lib/db.js";

export interface ListCamtStatementsQuery {
  page: number;
  perPage: number;
  bankAccountId?: string;
  status?: CamtStatementStatus;
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

function mapSummary(row: typeof camtStatements.$inferSelect): CamtStatementSummary {
  return {
    id: row.id,
    msgId: row.msgId,
    bankAccountId: row.bankAccountId,
    status: row.status,
    uploadedAt: row.createdAt.toISOString(),
    processedAt: row.processedAt?.toISOString() ?? null,
    totalCredits: row.totalCredits,
    matchedCredits: row.matchedCredits,
    unmatchedCredits: row.unmatchedCredits,
    statementFrom: row.statementFrom,
    statementTo: row.statementTo,
    // `originalFilename` is derived from the S3 path basename — the
    // upload service stores it at `{org_id}/camt053/{yyyy}/{mm}/{filename}`
    // so the last segment is what the operator saw locally.
    originalFilename: extractOriginalFilename(row.s3Path),
    error: row.error,
  };
}

function extractOriginalFilename(s3Path: string): string | null {
  if (!s3Path) return null;
  const idx = s3Path.lastIndexOf("/");
  if (idx < 0) return s3Path;
  return s3Path.slice(idx + 1) || null;
}

export async function listCamtStatements(
  orgId: string,
  query: ListCamtStatementsQuery,
): Promise<{ data: CamtStatementSummary[]; pagination: Pagination }> {
  const offset = (query.page - 1) * query.perPage;
  return withTenantContext(orgId, async (tx) => {
    const conditions = [eq(camtStatements.orgId, orgId)];
    if (query.bankAccountId) {
      conditions.push(eq(camtStatements.bankAccountId, query.bankAccountId));
    }
    if (query.status) {
      conditions.push(eq(camtStatements.status, query.status));
    }
    const where = and(...conditions);

    const [rows, totalRow] = await Promise.all([
      tx
        .select()
        .from(camtStatements)
        .where(where)
        .orderBy(desc(camtStatements.createdAt))
        .limit(query.perPage)
        .offset(offset),
      tx.select({ count: count() }).from(camtStatements).where(where),
    ]);

    const total = Number(totalRow[0]?.count ?? 0);
    return {
      data: rows.map(mapSummary),
      pagination: {
        page: query.page,
        perPage: query.perPage,
        total,
        totalPages: Math.ceil(total / query.perPage),
      },
    };
  });
}

export interface CamtStatementDetail extends CamtStatementSummary {
  bankAccount: Pick<BankAccount, "id" | "iban" | "bankName" | "currency"> | null;
  creditEntryCount: number;
  unreconciledCount: number;
  s3Path: string;
}

export async function getCamtStatement(
  orgId: string,
  id: string,
): Promise<CamtStatementDetail | null> {
  return withTenantContext(orgId, async (tx) => {
    const [row] = await tx
      .select()
      .from(camtStatements)
      .where(and(eq(camtStatements.id, id), eq(camtStatements.orgId, orgId)));
    if (!row) return null;

    const [account] = await tx
      .select({
        id: bankAccounts.id,
        iban: bankAccounts.iban,
        bankName: bankAccounts.bankName,
        currency: bankAccounts.currency,
      })
      .from(bankAccounts)
      .where(and(eq(bankAccounts.id, row.bankAccountId), eq(bankAccounts.orgId, orgId)));

    const [creditCount] = await tx
      .select({ count: count() })
      .from(camtCreditEntries)
      .where(and(eq(camtCreditEntries.statementId, id), eq(camtCreditEntries.orgId, orgId)));

    const [unrecCount] = await tx
      .select({ count: count() })
      .from(camtUnreconciledEntries)
      .innerJoin(camtCreditEntries, eq(camtUnreconciledEntries.creditEntryId, camtCreditEntries.id))
      .where(
        and(
          eq(camtCreditEntries.statementId, id),
          eq(camtCreditEntries.orgId, orgId),
          eq(camtUnreconciledEntries.status, "pending"),
        ),
      );

    return {
      ...mapSummary(row),
      bankAccount: account ?? null,
      creditEntryCount: Number(creditCount?.count ?? 0),
      unreconciledCount: Number(unrecCount?.count ?? 0),
      s3Path: row.s3Path,
    };
  });
}

/**
 * Reconciliation-health card (docs/25 §6 + §5.3) — last-N-days metrics
 * for the bank-account detail page. Default window = 90 days, matching
 * the operator's typical "are statements arriving?" timescale.
 */
export interface ReconciliationHealth {
  totalStatements: number;
  lastStatementImportedAt: string | null;
  totalCreditsLastN: number;
  matchedCreditsLastN: number;
  unmatchedCreditsLastN: number;
  totalUnreconciledPending: number;
  recentStatements: CamtStatementSummary[];
}

export async function getReconciliationHealth(
  orgId: string,
  bankAccountId: string,
  options: { windowDays?: number } = {},
): Promise<ReconciliationHealth | null> {
  const windowDays = options.windowDays ?? 90;
  return withTenantContext(orgId, async (tx) => {
    const [account] = await tx
      .select({ id: bankAccounts.id })
      .from(bankAccounts)
      .where(
        and(
          eq(bankAccounts.id, bankAccountId),
          eq(bankAccounts.orgId, orgId),
          isNull(bankAccounts.deletedAt),
        ),
      );
    if (!account) return null;

    const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    const [statsRow] = await tx
      .select({
        totalStatements: count(),
        lastImported: sql<Date | null>`MAX(${camtStatements.processedAt})`,
        totalCredits: sql<number>`COALESCE(SUM(CASE WHEN ${camtStatements.createdAt} >= ${cutoff.toISOString()} THEN ${camtStatements.totalCredits} ELSE 0 END), 0)::int`,
        matchedCredits: sql<number>`COALESCE(SUM(CASE WHEN ${camtStatements.createdAt} >= ${cutoff.toISOString()} THEN ${camtStatements.matchedCredits} ELSE 0 END), 0)::int`,
        unmatchedCredits: sql<number>`COALESCE(SUM(CASE WHEN ${camtStatements.createdAt} >= ${cutoff.toISOString()} THEN ${camtStatements.unmatchedCredits} ELSE 0 END), 0)::int`,
      })
      .from(camtStatements)
      .where(and(eq(camtStatements.orgId, orgId), eq(camtStatements.bankAccountId, bankAccountId)));

    const [unrecRow] = await tx
      .select({ count: count() })
      .from(camtUnreconciledEntries)
      .innerJoin(camtCreditEntries, eq(camtUnreconciledEntries.creditEntryId, camtCreditEntries.id))
      .innerJoin(camtStatements, eq(camtCreditEntries.statementId, camtStatements.id))
      .where(
        and(
          eq(camtCreditEntries.orgId, orgId),
          eq(camtStatements.bankAccountId, bankAccountId),
          eq(camtUnreconciledEntries.status, "pending"),
        ),
      );

    const recent = await tx
      .select()
      .from(camtStatements)
      .where(and(eq(camtStatements.orgId, orgId), eq(camtStatements.bankAccountId, bankAccountId)))
      .orderBy(desc(camtStatements.createdAt))
      .limit(5);

    return {
      totalStatements: Number(statsRow?.totalStatements ?? 0),
      lastStatementImportedAt:
        statsRow?.lastImported instanceof Date ? statsRow.lastImported.toISOString() : null,
      totalCreditsLastN: Number(statsRow?.totalCredits ?? 0),
      matchedCreditsLastN: Number(statsRow?.matchedCredits ?? 0),
      unmatchedCreditsLastN: Number(statsRow?.unmatchedCredits ?? 0),
      totalUnreconciledPending: Number(unrecRow?.count ?? 0),
      recentStatements: recent.map(mapSummary),
    };
  });
}

// Silence unused-import lints — `gte` is reserved for an alternative
// path that computes per-statement aggregates with a date predicate
// rather than the case-when above. Keeping it imported lets the swap
// land without a churn diff in this file.
void gte;
