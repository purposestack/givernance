// Issue #443 — Super-admin monthly platform finance report.
//
// Single module for the "Rapport mensuel" feature wired off the
// `/admin/finance` dashboard. Three responsibilities:
//
//  1. Resolve the target month — the most recent fully-completed
//     calendar month (e.g., on 2026-05-25 the target is 2026-04). The
//     route also accepts an explicit `month` body param (YYYY-MM) for
//     re-running an older month after a fix or for QA.
//
//  2. Idempotent INSERT into `platform_finance_reports` — the partial
//     unique index on `(month) WHERE status IN ('pending','ready')`
//     makes a same-month POST return the existing row instead of
//     re-enqueuing the worker.
//
//  3. Build the `kpi_snapshot` synchronously (re-uses
//     `buildFinanceSummary`) and enqueue the worker for the
//     PDF render + S3 upload (CPU + network IO that we keep off the
//     HTTP path).
//
// PLATFORM-LEVEL: every query goes through `systemDb`. The route
// guard chain `requireFlag(ADMIN_FINANCE_DASHBOARD) →
// requireSuperAdmin` is enforced in routes.ts (flag first so a
// scanner gets 404 without revealing the role requirement).

import { QUEUE_NAMES } from "@givernance/shared/jobs";
import { platformFinanceReports } from "@givernance/shared/schema";
import { Queue } from "bullmq";
import { and, desc, eq, inArray } from "drizzle-orm";
import { systemDb } from "../../../lib/db.js";
import { redis } from "../../../lib/redis.js";
import type { ResolvedPeriod } from "./period.js";
import { buildFinanceSummary, type SummaryServiceResult } from "./service.js";

const MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

let cachedQueue: Queue | null = null;
function reportsQueue(): Queue {
  if (cachedQueue) return cachedQueue;
  cachedQueue = new Queue(QUEUE_NAMES.PLATFORM_REPORTS, { connection: redis });
  return cachedQueue;
}

export class MonthValidationError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(detail);
    this.name = "MonthValidationError";
    this.detail = detail;
  }
}

/**
 * Resolve the most recent fully-completed calendar month as `YYYY-MM`,
 * relative to `now` (UTC). On 2026-05-25 returns "2026-04".
 */
export function previousMonth(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-indexed
  // Step into the previous month — month=0 (Jan) → Dec of prev year.
  const targetYear = month === 0 ? year - 1 : year;
  const targetMonth = month === 0 ? 12 : month;
  return `${targetYear}-${String(targetMonth).padStart(2, "0")}`;
}

/**
 * Validate a `YYYY-MM` string. Throws `MonthValidationError` for
 * malformed values, future months, and months before the 2024-01
 * platform floor (the same floor `period.ts` enforces).
 */
export function validateMonth(value: string, now: Date = new Date()): void {
  if (!MONTH_REGEX.test(value)) {
    throw new MonthValidationError(`month must match YYYY-MM (got '${value}')`);
  }
  const [yearStr, monthStr] = value.split("-");
  const year = Number.parseInt(yearStr ?? "", 10);
  const month = Number.parseInt(monthStr ?? "", 10);
  // Platform floor — same epoch as `period.ts`.
  if (year < 2024 || (year === 2024 && month < 1)) {
    throw new MonthValidationError("month is before the 2024-01 platform floor");
  }
  // Reject the current month (not yet complete) and any future month.
  const current = previousMonth(now);
  if (value > current) {
    throw new MonthValidationError(
      `month '${value}' is not a fully-completed calendar month yet (most recent: '${current}')`,
    );
  }
}

/**
 * Build a ResolvedPeriod that covers a full calendar month, with the
 * comparison window being the month before it.
 */
export function periodForMonth(month: string): ResolvedPeriod {
  const [yearStr, monthStr] = month.split("-");
  const year = Number.parseInt(yearStr ?? "", 10);
  const m = Number.parseInt(monthStr ?? "", 10);
  // Month boundaries in UTC. `from` is the 1st at 00:00, `to` is the
  // 1st of the next month at 00:00 (exclusive) — matches the
  // [from, to) convention `buildFinanceSummary` expects.
  const from = new Date(Date.UTC(year, m - 1, 1, 0, 0, 0, 0));
  const to = new Date(Date.UTC(year, m, 1, 0, 0, 0, 0));
  const windowMs = to.getTime() - from.getTime();
  const comparisonTo = from;
  const comparisonFrom = new Date(comparisonTo.getTime() - windowMs);
  return {
    from,
    to,
    label: month,
    comparisonFrom,
    comparisonTo,
    clamped: false,
  };
}

export type ReportStatus = "pending" | "ready" | "failed";

export interface ReportRow {
  id: string;
  month: string;
  status: ReportStatus;
  pdfS3Key: string | null;
  failureReason: string | null;
  createdAt: string;
  readyAt: string | null;
}

function rowToDto(row: typeof platformFinanceReports.$inferSelect): ReportRow {
  return {
    id: row.id,
    month: row.month,
    status: row.status as ReportStatus,
    pdfS3Key: row.pdfS3Key,
    failureReason: row.failureReason,
    createdAt: row.createdAt.toISOString(),
    readyAt: row.readyAt?.toISOString() ?? null,
  };
}

/**
 * Look up an existing live (pending or ready) report for a given
 * month. Returns null if none — the caller can then attempt the
 * idempotent INSERT path.
 */
async function findLiveByMonth(month: string): Promise<ReportRow | null> {
  const [row] = await systemDb
    .select()
    .from(platformFinanceReports)
    .where(
      and(
        eq(platformFinanceReports.month, month),
        inArray(platformFinanceReports.status, ["pending", "ready"]),
      ),
    )
    .limit(1);
  return row ? rowToDto(row) : null;
}

export async function findById(id: string): Promise<ReportRow | null> {
  const [row] = await systemDb
    .select()
    .from(platformFinanceReports)
    .where(eq(platformFinanceReports.id, id))
    .limit(1);
  return row ? rowToDto(row) : null;
}

export interface RequestMonthlyReportInput {
  month: string;
  requestedByPlatformAdminId: string | null;
  traceparent?: string;
}

export interface RequestMonthlyReportResult {
  row: ReportRow;
  replayed: boolean;
  snapshot: SummaryServiceResult | null;
}

/**
 * Idempotent request entry point. Always validates the month, then:
 *   - returns the live row if one exists (replayed=true, no enqueue);
 *   - else builds the snapshot, INSERTs a pending row, enqueues the
 *     worker job and returns replayed=false.
 *
 * The `kpi_snapshot` is built synchronously here (not in the worker)
 * because the underlying SQL aggregation reuses the dashboard's
 * 5-minute Redis cache when the super-admin has just viewed the same
 * period — the typical "view dashboard, click Generate report" flow
 * hits a warm cache. Pushing it into the worker would re-run the
 * aggregation cold.
 */
export async function requestMonthlyReport(
  input: RequestMonthlyReportInput,
  now: Date = new Date(),
): Promise<RequestMonthlyReportResult> {
  validateMonth(input.month, now);

  const existing = await findLiveByMonth(input.month);
  if (existing) {
    return { row: existing, replayed: true, snapshot: null };
  }

  // Build the snapshot for the month. The aggregation tolerates an
  // empty platform (no donations yet) — the KPIs come back as zeros
  // and the PDF still renders.
  const period = periodForMonth(input.month);
  const snapshot = await buildFinanceSummary({ period, filters: {} });

  // INSERT pending row + capture the assigned id for the BullMQ job
  // payload. The partial unique index protects against a same-month
  // race: if a second concurrent POST INSERTed first, the unique
  // violation surfaces as a Postgres error — we catch it and replay
  // the existing row.
  let inserted: typeof platformFinanceReports.$inferSelect;
  try {
    const rows = await systemDb
      .insert(platformFinanceReports)
      .values({
        month: input.month,
        status: "pending",
        kpiSnapshot: snapshot,
        requestedByPlatformAdminId: input.requestedByPlatformAdminId,
      })
      .returning();
    if (!rows[0]) {
      throw new Error("INSERT into platform_finance_reports returned no row");
    }
    inserted = rows[0];
  } catch (err) {
    // Race: another concurrent POST already inserted the live row —
    // collapse to the existing row instead of failing the caller.
    const replayed = await findLiveByMonth(input.month);
    if (replayed) {
      return { row: replayed, replayed: true, snapshot: null };
    }
    throw err;
  }

  // Stamp the row with the BullMQ job id so the polling GET can hint
  // at BullMQ state when the row is still pending after several
  // minutes (DLQ candidate signal).
  const jobId = `monthly-finance-report-${inserted.id}`;
  await reportsQueue().add(
    "generate-monthly-finance-report",
    {
      reportId: inserted.id,
      month: input.month,
      traceparent: input.traceparent,
    },
    {
      jobId,
      attempts: 3,
      backoff: { type: "exponential", delay: 60_000 },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
    },
  );

  await systemDb
    .update(platformFinanceReports)
    .set({ jobId })
    .where(eq(platformFinanceReports.id, inserted.id));

  return {
    row: { ...rowToDto(inserted), pdfS3Key: null },
    replayed: false,
    snapshot,
  };
}

/**
 * List the N most recent reports (any status). Powers a future
 * "previous reports" panel on the dashboard — not exposed by issue
 * #443 itself but trivial to add and keeps the API surface coherent.
 */
export async function listRecent(limit = 12): Promise<ReportRow[]> {
  const rows = await systemDb
    .select()
    .from(platformFinanceReports)
    .orderBy(desc(platformFinanceReports.createdAt))
    .limit(limit);
  return rows.map(rowToDto);
}
