/**
 * refresh_fx_cache — daily Fixer.io FX-rate cache warm-up (ADR-032 §2.1, Epic #416 Task 10).
 *
 * Collects every distinct currency that the platform must quote (active bank-
 * account settlement currencies + user display-currency overrides), calls
 * FxRateService.fetchAndCache() for each, and then enqueues a backfill_fx_rate
 * job so any donations still marked fx_pending = true are resolved.
 *
 * Failure model:
 *   - Per-currency failures are logged as warn and do NOT abort the batch.
 *     A single failing currency (e.g. an exotic currency Fixer.io doesn't
 *     support for that access plan) must not block every other currency.
 *   - The backfill job is only enqueued if ≥ 1 currency refreshed successfully.
 *   - The job itself never throws — a terminal failure is logged as error and
 *     BullMQ will retry according to the worker's defaultJobOpts.
 *
 * Feature-flag-first: the entire processor no-ops when
 * `donation.multi_currency` is off (defence in depth — the route-level gate is
 * the first wall; the worker is the second).
 */

import { FEATURE_FLAG_KEYS } from "@givernance/shared";
import {
  FX_CACHE_JOBS,
  FX_CACHE_QUEUE_NAME,
  type RefreshFxCachePayload,
} from "@givernance/shared/jobs";
import { bankAccounts, users } from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { Queue } from "bullmq";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import Redis from "ioredis";
import { env } from "../env.js";
import { db } from "../lib/db.js";
import { isFlagEnabled } from "../lib/flags.js";
import { makeFxRateService } from "../lib/fx-rate-service.js";
import { jobLogger } from "../lib/logger.js";

/** Create the fx_cache queue handle for enqueuing the backfill job. */
function createFxCacheQueue(): Queue {
  return new Queue(FX_CACHE_QUEUE_NAME, {
    connection: new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    }),
  });
}

/**
 * Platform base / reporting currency (ADR-032 §2.1). Always included in the
 * warm-set, regardless of tenant data.
 */
const PLATFORM_BASE_CURRENCY = "EUR";

/**
 * Build the deduplicated, upper-cased set of currencies the FX cache must warm.
 *
 * ALWAYS includes the platform base currency (EUR). The `/readyz` `fx` health
 * canary probes `fx:rates:EUR` unconditionally (`packages/api/src/modules/health/
 * routes.ts`), so the warm-up must guarantee EUR is fetched even when no tenant
 * has a bank account or a display-currency override yet. Without this, a fresh
 * deploy — or a tenant set that settles entirely in non-EUR currencies — leaves
 * `fx:rates:EUR` cold and flaps the fx subsystem to `down` despite a valid
 * FIXER_API_KEY and a running worker.
 *
 * Pure + exported so the always-warm-EUR contract is unit-testable without
 * booting Drizzle/Redis/BullMQ (mirrors `computeBalanceDelta`, ADR-032 §2.10).
 */
export function collectCurrenciesToWarm(
  bankAccountCurrencies: ReadonlyArray<{ currency: string | null }>,
  userDisplayCurrencies: ReadonlyArray<{ currency: string | null }>,
): string[] {
  const currencySet = new Set<string>([PLATFORM_BASE_CURRENCY]);
  for (const row of bankAccountCurrencies) {
    if (row.currency) currencySet.add(row.currency.toUpperCase());
  }
  for (const row of userDisplayCurrencies) {
    if (row.currency) currencySet.add(row.currency.toUpperCase());
  }
  return [...currencySet];
}

export async function processRefreshFxCache(job: Job<RefreshFxCachePayload>): Promise<void> {
  const { triggeredBy } = job.data;
  const log = jobLogger({ jobId: job.id });

  log.info({ triggeredBy }, "refresh_fx_cache: starting");

  // Feature-flag gate (defence in depth — second wall after the schedule gate).
  const enabled = await isFlagEnabled(FEATURE_FLAG_KEYS.DONATION_MULTI_CURRENCY);
  if (!enabled) {
    log.info(
      { job: "refresh_fx_cache", triggeredBy },
      "refresh_fx_cache: flag donation.multi_currency off — skipping",
    );
    return;
  }

  // ── Collect distinct currencies to warm ────────────────────────────────────

  // Active bank-account settlement currencies
  const bankAccountCurrencies = await db
    .selectDistinct({ currency: bankAccounts.currency })
    .from(bankAccounts)
    .where(and(eq(bankAccounts.isActive, true), isNull(bankAccounts.deletedAt)));

  // User display-currency overrides (non-null only)
  const userDisplayCurrencies = await db
    .selectDistinct({ currency: users.displayCurrency })
    .from(users)
    .where(and(isNotNull(users.displayCurrency), isNull(users.deletedAt)));

  // Union {bank-account currencies} ∪ {user display currencies} ∪ {EUR base}.
  // EUR is always present (see collectCurrenciesToWarm), so the set is never
  // empty and the health canary key fx:rates:EUR always gets warmed.
  const currencies = collectCurrenciesToWarm(bankAccountCurrencies, userDisplayCurrencies);
  log.info({ currencies, count: currencies.length }, "refresh_fx_cache: currencies to warm");

  // FxRateService bound to the worker's shared Redis + FIXER_API_KEY (issue #480).
  const fxService = makeFxRateService(log);

  // ── Refresh each currency ───────────────────────────────────────────────────
  let successCount = 0;

  for (const currency of currencies) {
    const startMs = Date.now();
    try {
      const { pairsLoaded } = await fxService.fetchAndCache(currency);
      const durationMs = Date.now() - startMs;
      log.info(
        { job: "refresh_fx_cache", base: currency, pairsLoaded, durationMs },
        "refresh_fx_cache: currency refreshed",
      );
      successCount++;
    } catch (err) {
      log.warn(
        {
          job: "refresh_fx_cache",
          base: currency,
          err: err instanceof Error ? err.message : String(err),
        },
        "refresh_fx_cache: failed to refresh currency — continuing",
      );
    }
  }

  log.info(
    { triggeredBy, successCount, total: currencies.length },
    "refresh_fx_cache: cache warm-up complete",
  );

  // ── Enqueue backfill if ≥ 1 currency refreshed successfully ────────────────
  if (successCount > 0) {
    const fxQueue = createFxCacheQueue();
    try {
      await fxQueue.add(
        FX_CACHE_JOBS.BACKFILL,
        { triggeredBy: "refresh_fx_cache" },
        {
          jobId: `backfill-fx-rate-${Date.now()}`,
          attempts: 3,
          backoff: { type: "exponential", delay: 60_000 },
          removeOnComplete: { count: 10 },
          removeOnFail: { count: 50 },
        },
      );
      log.info({ triggeredBy }, "refresh_fx_cache: backfill_fx_rate job enqueued");
    } finally {
      await fxQueue.close();
    }
  } else {
    log.warn(
      { triggeredBy },
      "refresh_fx_cache: all currencies failed — backfill_fx_rate not enqueued",
    );
  }
}
