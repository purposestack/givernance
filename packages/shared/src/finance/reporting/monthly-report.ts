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
//     makes a same-month request return the existing row instead of
//     re-enqueuing the worker.
//
//  3. Build the `kpi_snapshot` synchronously (re-uses
//     `buildFinanceSummary`) and enqueue the worker for the
//     PDF render + S3 upload (CPU + network IO that we keep off the
//     HTTP path).
//
// SHARED (issue #443): both the `db` handle and the enqueue function
// are dependency-injected so the API (manual report + dashboard) and
// the worker (monthly cron + boot backfill) drive the SAME idempotent
// request flow from one implementation. The API passes `systemDb` +
// an enqueue closure backed by its PLATFORM_REPORTS queue; the worker
// passes its owner-pool `db` + its own PLATFORM_REPORTS queue closure.
//
// PLATFORM-LEVEL: every query goes through the injected owner `db`
// (the table has no org_id, no RLS). The API route guard
// `requireSuperAdmin` is enforced in routes.ts.

import { platformFinanceReports } from "@givernance/shared/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../schema/index.js";
import type { ResolvedPeriod } from "./period.js";
import { buildFinanceSummary, type SummaryInput, type SummaryServiceResult } from "./summary.js";

/** Injected Drizzle handle (owner pool — the table is platform-level, no RLS). */
type FinanceDb = NodePgDatabase<typeof schema>;

const MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Dependencies injected into the request/backfill orchestration so the
 * shared flow stays free of the per-package queue + redis singletons.
 */
export interface MonthlyReportDeps {
  /** Owner-pool Drizzle handle for the platform-level table. */
  db: FinanceDb;
  /**
   * Enqueue the PDF-generation job for a freshly-inserted report row.
   * The caller wires this to its own PLATFORM_REPORTS queue (API or
   * worker), using `PLATFORM_REPORTS_JOBS.GENERATE_PDF` as the job name.
   */
  enqueueGenerate: (
    jobId: string,
    data: { reportId: string; month: string; traceparent?: string },
  ) => Promise<void>;
  /**
   * Override the snapshot builder — defaults to
   * `(input) => buildFinanceSummary(deps.db, input)`. Exposed mainly so
   * a caller can substitute a warm-cache build, and for testing.
   */
  buildSnapshot?: (input: SummaryInput) => Promise<SummaryServiceResult>;
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
async function findLiveByMonth(db: FinanceDb, month: string): Promise<ReportRow | null> {
  const [row] = await db
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

/**
 * Mark an existing report row as superseded — set `status='failed'`
 * with a recognisable `failure_reason`. The partial unique index is
 * scoped to `pending|ready`, so flipping to `failed` frees up the
 * month slot for a fresh `requestMonthlyReport` call. The old row
 * stays in the table forever (RGPD Art. 5.2 accountability — we
 * never lose the audit trail of what was generated).
 */
async function markSuperseded(db: FinanceDb, id: string): Promise<void> {
  await db
    .update(platformFinanceReports)
    .set({ status: "failed", failureReason: "Remplacé par régénération" })
    .where(eq(platformFinanceReports.id, id));
}

export interface RegenerateResult {
  /** The new pending row that the worker is about to render. */
  newRow: ReportRow;
  /** The row that was just superseded (always `failed` status now). */
  supersededRow: ReportRow;
}

export class RegenerateError extends Error {
  readonly detail: string;
  readonly statusCode: number;
  constructor(statusCode: number, detail: string) {
    super(detail);
    this.name = "RegenerateError";
    this.statusCode = statusCode;
    this.detail = detail;
  }
}

/**
 * Regenerate an existing report. Flow:
 *  1. Look up the source row.
 *  2. Refuse if it's still `pending` (worker hasn't finished yet —
 *     wait or let it fail naturally before regenerating).
 *  3. Mark the source row `failed` with reason `Remplacé par
 *     régénération`. The partial unique index is now free.
 *  4. Call `requestMonthlyReport` for the same month — this builds
 *     a fresh snapshot with the current SQL + enqueues the worker.
 *
 * The caller is responsible for emitting the audit_log row with
 * `action='regenerate'` and the supersedes pointer.
 */
export async function regenerateReport(
  deps: MonthlyReportDeps,
  input: {
    sourceId: string;
    requestedByPlatformAdminId: string | null;
    traceparent?: string;
  },
): Promise<RegenerateResult> {
  const source = await findById(deps.db, input.sourceId);
  if (!source) {
    throw new RegenerateError(404, "Rapport introuvable.");
  }
  if (source.status === "pending") {
    throw new RegenerateError(
      409,
      "Le rapport est encore en cours de génération — attendez qu'il soit prêt avant de le régénérer.",
    );
  }

  await markSuperseded(deps.db, source.id);

  const fresh = await requestMonthlyReport(deps, {
    month: source.month,
    requestedByPlatformAdminId: input.requestedByPlatformAdminId,
    traceparent: input.traceparent,
  });

  return {
    newRow: fresh.row,
    supersededRow: { ...source, status: "failed", failureReason: "Remplacé par régénération" },
  };
}

export async function findById(db: FinanceDb, id: string): Promise<ReportRow | null> {
  const [row] = await db
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
  deps: MonthlyReportDeps,
  input: RequestMonthlyReportInput,
  now: Date = new Date(),
): Promise<RequestMonthlyReportResult> {
  validateMonth(input.month, now);

  const existing = await findLiveByMonth(deps.db, input.month);
  if (existing) {
    return { row: existing, replayed: true, snapshot: null };
  }

  // Build the snapshot for the month. The aggregation tolerates an
  // empty platform (no donations yet) — the KPIs come back as zeros
  // and the PDF still renders.
  const period = periodForMonth(input.month);
  const buildSnapshot =
    deps.buildSnapshot ?? ((i: SummaryInput) => buildFinanceSummary(deps.db, i));
  const snapshot = await buildSnapshot({ period, filters: {} });

  // INSERT pending row + capture the assigned id for the BullMQ job
  // payload. The partial unique index protects against a same-month
  // race: if a second concurrent request INSERTed first, the unique
  // violation surfaces as a Postgres error — we catch it and replay
  // the existing row.
  let inserted: typeof platformFinanceReports.$inferSelect;
  try {
    const rows = await deps.db
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
    // Race: another concurrent request already inserted the live row —
    // collapse to the existing row instead of failing the caller.
    const replayed = await findLiveByMonth(deps.db, input.month);
    if (replayed) {
      return { row: replayed, replayed: true, snapshot: null };
    }
    throw err;
  }

  // Stamp the row with the BullMQ job id so the polling GET can hint
  // at BullMQ state when the row is still pending after several
  // minutes (DLQ candidate signal).
  const jobId = `monthly-finance-report-${inserted.id}`;
  await deps.enqueueGenerate(jobId, {
    reportId: inserted.id,
    month: input.month,
    traceparent: input.traceparent,
  });

  await deps.db
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
 * Walk the last `n` fully-completed calendar months back from `now`
 * and return the YYYY-MM labels in chronological order
 * (oldest first). Used by the backfill route to know which months
 * deserve a report.
 */
export function lastNMonths(n: number, now: Date = new Date()): string[] {
  const months: string[] = [];
  const baseYear = now.getUTCFullYear();
  const baseMonth = now.getUTCMonth() + 1; // 1-indexed
  const baseTotal = baseYear * 12 + (baseMonth - 1);
  // Step into the most recent fully-completed month (matches
  // previousMonth semantics), then walk back n entries.
  for (let i = n; i >= 1; i -= 1) {
    const total = baseTotal - i;
    const y = Math.floor(total / 12);
    const m = (total % 12) + 1;
    months.push(`${y}-${String(m).padStart(2, "0")}`);
  }
  return months;
}

export interface BackfillResult {
  /** Months that did not yet have a live row and were enqueued. */
  enqueued: ReportRow[];
  /** Months that already had a live (pending|ready) row — left untouched. */
  skipped: ReportRow[];
}

/**
 * Backfill — for each of the last 12 fully-completed calendar months
 * (capped to the 2024-01 platform floor), idempotently request a
 * monthly report. Calls share the same `requestMonthlyReport` flow as
 * the manual button so the worker queue, S3 layout, audit shape and
 * snapshot semantics stay identical between manual / backfill /
 * cron-triggered paths.
 */
export async function backfillLast12Months(
  deps: MonthlyReportDeps,
  input: { requestedByPlatformAdminId: string | null; traceparent?: string },
  now: Date = new Date(),
): Promise<BackfillResult> {
  const enqueued: ReportRow[] = [];
  const skipped: ReportRow[] = [];

  for (const month of lastNMonths(12, now)) {
    // The 2024-01 floor — silently skip pre-platform months instead of
    // throwing, so a backfill from 2024-06 still works partially.
    try {
      validateMonth(month, now);
    } catch {
      continue;
    }
    const result = await requestMonthlyReport(
      deps,
      {
        month,
        requestedByPlatformAdminId: input.requestedByPlatformAdminId,
        traceparent: input.traceparent,
      },
      now,
    );
    if (result.replayed) skipped.push(result.row);
    else enqueued.push(result.row);
  }

  return { enqueued, skipped };
}

/**
 * List the N most recent reports, **one row per month** — preferring
 * `ready` over `pending` over `failed`. Powers the dashboard's
 * "Archive" panel. Without the per-month dedup, an operator who hits
 * the manual button (or any transient `failed` retry burst) would see
 * the panel pile up with duplicate-month entries.
 *
 * Returned in chronological-descending order (most recent month first).
 */
export async function listRecent(db: FinanceDb, limit = 12): Promise<ReportRow[]> {
  // DISTINCT ON (month) is the canonical Postgres dedup. The ORDER BY
  // inside the subquery is the tiebreaker: `ready` first, then
  // `pending`, then `failed`, and within each status the most-recently
  // created. The outer ORDER BY then re-sorts by `month DESC` so the
  // panel shows newest months on top.
  const rows = await db.execute<{
    id: string;
    month: string;
    status: string;
    pdf_s3_key: string | null;
    failure_reason: string | null;
    created_at: Date;
    ready_at: Date | null;
  }>(sql`
    SELECT id, month, status, pdf_s3_key, failure_reason, created_at, ready_at
    FROM (
      SELECT DISTINCT ON (month)
        id, month, status, pdf_s3_key, failure_reason, created_at, ready_at
      FROM platform_finance_reports
      ORDER BY month, CASE status
        WHEN 'ready' THEN 0
        WHEN 'pending' THEN 1
        WHEN 'failed' THEN 2
        ELSE 3
      END, created_at DESC
    ) latest
    ORDER BY month DESC
    LIMIT ${limit}
  `);
  return rows.rows.map((r) => ({
    id: r.id,
    month: r.month,
    status: r.status as ReportStatus,
    pdfS3Key: r.pdf_s3_key,
    failureReason: r.failure_reason,
    createdAt: new Date(r.created_at).toISOString(),
    readyAt: r.ready_at ? new Date(r.ready_at).toISOString() : null,
  }));
}
