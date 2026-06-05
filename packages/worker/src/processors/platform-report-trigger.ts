/**
 * Worker processor — monthly platform finance report auto-trigger (issue #443).
 *
 * Replaces the API-side `setTimeout` chain in `auto-monthly-cron.ts`
 * with a proper BullMQ repeatable job. Two responsibilities:
 *
 *  1. **Monthly cron** — fires at 03:30 UTC on the 1st of each month.
 *     Resolves the previous calendar month, idempotently inserts a
 *     pending row into `platform_finance_reports` (with kpi_snapshot
 *     built right here, via the worker-side `buildFinanceSummary`),
 *     and enqueues the PDF generation job.
 *
 *  2. **Boot-time backfill** — a one-shot job enqueued at worker
 *     startup with `{ mode: "backfill" }` walks the last 12 calendar
 *     months and idempotently triggers any that are missing.
 *
 * Both paths are gated by the `admin.finance_dashboard` feature flag —
 * the same early-return posture as every other cron-gated processor.
 */

import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import { PLATFORM_REPORTS_JOBS, QUEUE_NAMES } from "@givernance/shared/jobs";
import { platformFinanceReports } from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { Queue } from "bullmq";
import { and, eq, inArray } from "drizzle-orm";
import Redis from "ioredis";
import { env } from "../env.js";
import { db as systemDb } from "../lib/db.js";
import { isFlagEnabled } from "../lib/flags.js";
import { jobLogger } from "../lib/logger.js";
import type { ResolvedPeriod } from "../services/finance/period.js";
import { buildFinanceSummary } from "../services/finance/summary.js";

const MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;
const PLATFORM_FLOOR = "2024-01";

export interface PlatformReportTriggerPayload {
  /** "single" (default) — trigger the previous month only.
   *  "backfill" — walk the last 12 months and trigger any missing ones. */
  mode?: "single" | "backfill";
}

// Lazy-initialised queue — reuses a single connection per worker process.
let _pdfQueue: Queue | null = null;
function getPdfQueue(): Queue {
  if (_pdfQueue) return _pdfQueue;
  const conn = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
  _pdfQueue = new Queue(QUEUE_NAMES.PLATFORM_REPORTS, { connection: conn });
  return _pdfQueue;
}

/** Resolve YYYY-MM for the most recent fully-completed calendar month. */
function previousMonth(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-indexed
  const targetYear = month === 0 ? year - 1 : year;
  const targetMonth = month === 0 ? 12 : month;
  return `${targetYear}-${String(targetMonth).padStart(2, "0")}`;
}

function isValidMonth(month: string, now: Date = new Date()): boolean {
  if (!MONTH_REGEX.test(month)) return false;
  if (month < PLATFORM_FLOOR) return false;
  if (month > previousMonth(now)) return false;
  return true;
}

/** Build a ResolvedPeriod covering a full calendar month. */
function periodForMonth(month: string): ResolvedPeriod {
  const [yearStr, monthStr] = month.split("-");
  const year = Number.parseInt(yearStr ?? "", 10);
  const m = Number.parseInt(monthStr ?? "", 10);
  const from = new Date(Date.UTC(year, m - 1, 1, 0, 0, 0, 0));
  const to = new Date(Date.UTC(year, m, 1, 0, 0, 0, 0));
  const windowMs = to.getTime() - from.getTime();
  const comparisonTo = from;
  const comparisonFrom = new Date(comparisonTo.getTime() - windowMs);
  return { from, to, label: month, comparisonFrom, comparisonTo, clamped: false };
}

/** Last `n` fully-completed calendar months, oldest first. */
function lastNMonths(n: number, now: Date = new Date()): string[] {
  const months: string[] = [];
  const baseYear = now.getUTCFullYear();
  const baseMonth = now.getUTCMonth() + 1; // 1-indexed
  const baseTotal = baseYear * 12 + (baseMonth - 1);
  for (let i = n; i >= 1; i -= 1) {
    const total = baseTotal - i;
    const y = Math.floor(total / 12);
    const mIdx = (total % 12) + 1;
    months.push(`${y}-${String(mIdx).padStart(2, "0")}`);
  }
  return months;
}

async function findLiveByMonth(month: string): Promise<boolean> {
  const rows = await systemDb
    .select({ id: platformFinanceReports.id })
    .from(platformFinanceReports)
    .where(
      and(
        eq(platformFinanceReports.month, month),
        inArray(platformFinanceReports.status, ["pending", "ready"]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function triggerMonth(
  month: string,
  log: ReturnType<typeof jobLogger>,
): Promise<"enqueued" | "skipped" | "invalid"> {
  const now = new Date();
  if (!isValidMonth(month, now)) {
    log.info({ month }, "platform_report_trigger: month out of valid range — skipping");
    return "invalid";
  }

  if (await findLiveByMonth(month)) {
    log.info({ month }, "platform_report_trigger: live row already exists — idempotent skip");
    return "skipped";
  }

  const period = periodForMonth(month);
  const snapshot = await buildFinanceSummary({ period, filters: {} });

  let insertedId: string;
  try {
    const rows = await systemDb
      .insert(platformFinanceReports)
      .values({
        month,
        status: "pending",
        kpiSnapshot: snapshot,
        requestedByPlatformAdminId: null,
      })
      .returning({ id: platformFinanceReports.id });

    if (!rows[0]) throw new Error("INSERT returned no row");
    insertedId = rows[0].id;
  } catch {
    // Race: another process inserted first — treat as idempotent.
    if (await findLiveByMonth(month)) {
      log.info({ month }, "platform_report_trigger: race resolved — idempotent skip");
      return "skipped";
    }
    throw new Error(`Failed to insert platform_finance_reports row for month=${month}`);
  }

  const jobId = `monthly-finance-report-${insertedId}`;
  await getPdfQueue().add(
    PLATFORM_REPORTS_JOBS.GENERATE_PDF,
    { reportId: insertedId, month },
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
    .where(eq(platformFinanceReports.id, insertedId));

  log.info({ month, reportId: insertedId }, "platform_report_trigger: report enqueued");
  return "enqueued";
}

export async function processPlatformReportAutoTrigger(
  job: Job<PlatformReportTriggerPayload>,
): Promise<void> {
  const log = jobLogger({ jobId: job.id });

  const flagOn = await isFlagEnabled(FEATURE_FLAG_KEYS.ADMIN_FINANCE_DASHBOARD);
  if (!flagOn) {
    log.info("platform_report_trigger: flag admin.finance_dashboard off — no-op");
    return;
  }

  const mode = job.data?.mode ?? "single";

  if (mode === "backfill") {
    const months = lastNMonths(12);
    let enqueued = 0;
    let skipped = 0;
    for (const month of months) {
      const result = await triggerMonth(month, log);
      if (result === "enqueued") enqueued++;
      if (result === "skipped") skipped++;
    }
    log.info({ enqueued, skipped }, "platform_report_trigger: backfill complete");
    return;
  }

  const month = previousMonth();
  await triggerMonth(month, log);
}
