// Issue #443 — Super-admin monthly platform finance report.
//
// Thin shim (issue #443 de-dup): the orchestration now lives in the
// shared `@givernance/shared/finance/reporting` module so the API
// (manual report + backfill button) and the worker (monthly cron +
// boot backfill) drive the SAME idempotent request flow from one copy.
//
// The shared flow is dependency-injected with an owner `db` handle and
// an `enqueueGenerate` closure. Here we pre-bind the API's `systemDb`
// and an enqueue closure backed by the API's lazily-constructed
// PLATFORM_REPORTS queue (preserving the original queue construction)
// so every existing route call site keeps its current signature. The
// enqueued job name is `PLATFORM_REPORTS_JOBS.GENERATE_PDF` — the same
// constant the worker's cron trigger uses, so API + worker agree.

import {
  type MonthlyReportDeps,
  backfillLast12Months as sharedBackfill,
  findById as sharedFindById,
  listRecent as sharedListRecent,
  regenerateReport as sharedRegenerate,
  requestMonthlyReport as sharedRequest,
} from "@givernance/shared/finance/reporting";
import { PLATFORM_REPORTS_JOBS, QUEUE_NAMES } from "@givernance/shared/jobs";
import { Queue } from "bullmq";
import { systemDb } from "../../../lib/db.js";
import { redis } from "../../../lib/redis.js";

let cachedQueue: Queue | null = null;
function reportsQueue(): Queue {
  if (cachedQueue) return cachedQueue;
  cachedQueue = new Queue(QUEUE_NAMES.PLATFORM_REPORTS, { connection: redis });
  return cachedQueue;
}

const enqueueGenerate: MonthlyReportDeps["enqueueGenerate"] = async (jobId, data) => {
  await reportsQueue().add(PLATFORM_REPORTS_JOBS.GENERATE_PDF, data, {
    jobId,
    attempts: 3,
    backoff: { type: "exponential", delay: 60_000 },
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 50 },
  });
};

// Built lazily — `systemDb` is read at first call, not at module load,
// so a test that mocks `lib/db.js` without a `systemDb` export (e.g.
// health/routes.test.ts) doesn't trip Vitest's missing-export guard
// just by importing the route tree.
function deps(): MonthlyReportDeps {
  return { db: systemDb, enqueueGenerate };
}

export function requestMonthlyReport(
  input: Parameters<typeof sharedRequest>[1],
  now?: Date,
): ReturnType<typeof sharedRequest> {
  return sharedRequest(deps(), input, now);
}

export function backfillLast12Months(
  input: Parameters<typeof sharedBackfill>[1],
  now?: Date,
): ReturnType<typeof sharedBackfill> {
  return sharedBackfill(deps(), input, now);
}

export function regenerateReport(
  input: Parameters<typeof sharedRegenerate>[1],
): ReturnType<typeof sharedRegenerate> {
  return sharedRegenerate(deps(), input);
}

export function findById(id: string): ReturnType<typeof sharedFindById> {
  return sharedFindById(systemDb, id);
}

export function listRecent(limit?: number): ReturnType<typeof sharedListRecent> {
  return sharedListRecent(systemDb, limit);
}

// Pure helpers + types + error classes re-exported verbatim from shared.
export {
  type BackfillResult,
  lastNMonths,
  MonthValidationError,
  periodForMonth,
  previousMonth,
  RegenerateError,
  type RegenerateResult,
  type ReportRow,
  type ReportStatus,
  type RequestMonthlyReportInput,
  type RequestMonthlyReportResult,
  validateMonth,
} from "@givernance/shared/finance/reporting";
