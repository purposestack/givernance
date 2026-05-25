// Issue #443 — automatic monthly report generation + startup backfill.
//
// Two responsibilities, both in-process in the API:
//
//   1. **Boot-time backfill** — on the first ready event the API
//      checks the `platform_finance_reports` table and idempotently
//      enqueues a report for every fully-completed calendar month in
//      the trailing-12 window that doesn't already have a live row.
//      Rationale: the bucket retains 12 months, so this keeps the
//      retention window populated even after a fresh deploy into a
//      tenant pool that already has historical donations.
//
//   2. **Monthly auto-cron** — a `setTimeout` chain that fires at
//      03:30 UTC on the 1st of each month and calls
//      `requestMonthlyReport()` for the previous month. The unique
//      index handles multi-replica races (only one INSERT wins; the
//      others see the live row and replay).
//
// Both paths funnel through `requestMonthlyReport` so the worker
// queue, snapshot semantics, S3 layout and audit shape are identical
// to the manual button.
//
// The cron is gated by the `ADMIN_FINANCE_DASHBOARD` feature flag
// (re-checked at each fire, so a paused rollout doesn't churn
// Postgres for nothing).

import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import type { FastifyBaseLogger } from "fastify";
import { flagService } from "../../../lib/flags/flag-service.js";
import { backfillLast12Months, previousMonth, requestMonthlyReport } from "./monthly-report.js";

const CRON_HOUR_UTC = 3;
const CRON_MINUTE_UTC = 30;

/**
 * Return the next firing instant (a `Date`) at the next 1st-of-month
 * at 03:30 UTC, strictly after `now`.
 */
export function nextMonthlyFire(now: Date = new Date()): Date {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-indexed
  // Candidate: 1st of the CURRENT month at 03:30 UTC.
  let candidate = new Date(Date.UTC(y, m, 1, CRON_HOUR_UTC, CRON_MINUTE_UTC, 0, 0));
  if (candidate.getTime() <= now.getTime()) {
    // Already past — roll forward to the 1st of the NEXT month.
    candidate = new Date(Date.UTC(y, m + 1, 1, CRON_HOUR_UTC, CRON_MINUTE_UTC, 0, 0));
  }
  return candidate;
}

interface SchedulerHandle {
  cancel: () => void;
}

/**
 * Start both the boot-time backfill and the recurring monthly cron.
 * The returned handle's `cancel()` should be wired to Fastify's
 * `onClose` hook so test suites and graceful-shutdown paths don't
 * leak the scheduled timer.
 */
export function startMonthlyReportScheduler(log: FastifyBaseLogger): SchedulerHandle {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;

  async function fire(): Promise<void> {
    if (cancelled) return;

    const enabled = await flagService.isEnabled(FEATURE_FLAG_KEYS.ADMIN_FINANCE_DASHBOARD);
    if (!enabled) {
      log.info(
        { cron: "monthly_finance_report" },
        "Monthly report cron fired but flag is off — no-op",
      );
      return;
    }

    try {
      const result = await requestMonthlyReport({
        requestedByPlatformAdminId: null,
        month: previousMonth(),
      });
      log.info(
        {
          cron: "monthly_finance_report",
          reportId: result.row.id,
          month: result.row.month,
          replayed: result.replayed,
        },
        "Monthly report cron fired",
      );
    } catch (err) {
      log.error(
        { err, cron: "monthly_finance_report" },
        "Monthly report cron threw — will retry at next 1st-of-month",
      );
    }
  }

  function schedule(): void {
    if (cancelled) return;
    const next = nextMonthlyFire();
    const delay = Math.max(1000, next.getTime() - Date.now());
    log.info(
      { cron: "monthly_finance_report", nextFire: next.toISOString() },
      "Monthly report cron scheduled",
    );
    timeoutHandle = setTimeout(() => {
      void fire().finally(() => schedule());
    }, delay);
    // Never let a long setTimeout keep the process alive on its own —
    // the HTTP server is the lifecycle owner.
    timeoutHandle.unref?.();
  }

  // Boot-time backfill — fire-and-forget; failures are logged but
  // never block server boot.
  async function backfill(): Promise<void> {
    const enabled = await flagService.isEnabled(FEATURE_FLAG_KEYS.ADMIN_FINANCE_DASHBOARD);
    if (!enabled) {
      log.info({ backfill: "monthly_finance_report" }, "Boot-time backfill skipped — flag is off");
      return;
    }
    try {
      const result = await backfillLast12Months({ requestedByPlatformAdminId: null });
      log.info(
        {
          backfill: "monthly_finance_report",
          enqueuedCount: result.enqueued.length,
          skippedCount: result.skipped.length,
          enqueuedMonths: result.enqueued.map((r) => r.month),
        },
        "Boot-time backfill complete",
      );
    } catch (err) {
      log.error({ err, backfill: "monthly_finance_report" }, "Boot-time backfill threw");
    }
  }

  void backfill();
  schedule();

  return {
    cancel: () => {
      cancelled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
    },
  };
}
