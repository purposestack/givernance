/**
 * Worker processor — monthly platform finance report auto-trigger (issue #443).
 *
 * Replaces the API-side `setTimeout` chain in `auto-monthly-cron.ts`
 * with a proper BullMQ repeatable job. Two responsibilities:
 *
 *  1. **Monthly cron** — fires at 03:30 UTC on the 1st of each month.
 *     Resolves the previous calendar month and idempotently requests a
 *     monthly report (insert a pending `platform_finance_reports` row
 *     with the kpi_snapshot built right here, then enqueue the PDF job).
 *
 *  2. **Boot-time backfill** — a one-shot job enqueued at worker
 *     startup with `{ mode: "backfill" }` walks the last 12 calendar
 *     months and idempotently triggers any that are missing.
 *
 * De-dup (issue #443): the request flow lives in the shared
 * `@givernance/shared/finance/reporting` module so the API (manual
 * report + dashboard) and this cron drive the SAME idempotent
 * `requestMonthlyReport` / `backfillLast12Months`. This processor is
 * the thin worker adapter — it injects the worker's owner-pool `db`
 * and a PLATFORM_REPORTS enqueue closure.
 */

import {
  backfillLast12Months,
  type MonthlyReportDeps,
  previousMonth,
  requestMonthlyReport,
} from "@givernance/shared/finance/reporting";
import { PLATFORM_REPORTS_JOBS, QUEUE_NAMES } from "@givernance/shared/jobs";
import type { Job } from "bullmq";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { env } from "../env.js";
// Owner pool — `platform_finance_reports` is a platform-level table
// (no org_id, no RLS), same as `generate-monthly-finance-report.ts`.
import { db as systemDb } from "../lib/db.js";
import { jobLogger } from "../lib/logger.js";

export interface PlatformReportTriggerPayload {
  /** "single" (default) — trigger the previous month only.
   *  "backfill" — walk the last 12 months and trigger any missing ones. */
  mode?: "single" | "backfill";
}

// Lazy-initialised queue — reuses a single connection per worker process.
// Uses the same connection options as the worker's `createRedisConnection`
// so the PLATFORM_REPORTS enqueue here matches the rest of the worker's
// queue infra. (worker.ts owns its own queue handle for scheduling the
// repeatable trigger; importing it here would be a circular dependency.)
let _pdfQueue: Queue | null = null;
function getPdfQueue(): Queue {
  if (_pdfQueue) return _pdfQueue;
  const conn = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
  _pdfQueue = new Queue(QUEUE_NAMES.PLATFORM_REPORTS, { connection: conn });
  return _pdfQueue;
}

function deps(): MonthlyReportDeps {
  return {
    db: systemDb,
    enqueueGenerate: async (jobId, data) => {
      await getPdfQueue().add(PLATFORM_REPORTS_JOBS.GENERATE_PDF, data, {
        jobId,
        attempts: 3,
        backoff: { type: "exponential", delay: 60_000 },
        removeOnComplete: { count: 10 },
        removeOnFail: { count: 50 },
      });
    },
  };
}

export async function processPlatformReportAutoTrigger(
  job: Job<PlatformReportTriggerPayload>,
): Promise<void> {
  const log = jobLogger({ jobId: job.id });

  const mode = job.data?.mode ?? "single";

  if (mode === "backfill") {
    // The shared backfill loops the last 12 months and idempotently
    // skips any month that already has a live (pending|ready) row.
    const { enqueued, skipped } = await backfillLast12Months(deps(), {
      requestedByPlatformAdminId: null,
    });
    log.info(
      { enqueued: enqueued.length, skipped: skipped.length },
      "platform_report_trigger: backfill complete",
    );
    return;
  }

  const month = previousMonth();
  const result = await requestMonthlyReport(deps(), {
    month,
    requestedByPlatformAdminId: null,
  });
  if (result.replayed) {
    log.info({ month }, "platform_report_trigger: live row already exists — idempotent skip");
  } else {
    log.info({ month, reportId: result.row.id }, "platform_report_trigger: report enqueued");
  }
}
