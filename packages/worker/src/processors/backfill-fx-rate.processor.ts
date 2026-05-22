/**
 * backfill_fx_rate — resolve historical FX rates for fx_pending donations
 * (ADR-031 §1.4 + §2.1, Epic #416 Task 11).
 *
 * Donations land with `fx_pending = true` when Fixer.io was unavailable at
 * checkout time. This processor batches through them oldest-first, fetches
 * the historical rate from Fixer.io's date endpoint, fills in:
 *
 *   exchange_rate
 *   exchange_rate_source = 'backfilled'
 *   exchange_rate_timestamp
 *   amount_in_settlement_currency_cents
 *   fx_pending = false
 *
 * and writes an audit_log row for each resolved donation.
 *
 * Settlement-currency resolution chain:
 *   donation → donation_allocations → funds → bank_accounts.currency
 *
 * If the chain is broken (no allocation, no fund, no bank account), the
 * donation is logged as warn and skipped — it will remain fx_pending until
 * an operator fixes the fund assignment.
 *
 * Fixer.io unavailability aborts the entire batch (do NOT flip fx_pending):
 * we'd rather leave the row pending and retry than record a stale/wrong rate.
 *
 * Self-scheduling: after a successful batch, if more fx_pending rows remain,
 * this job re-enqueues itself with a 10-minute delay.
 *
 * Feature-flag-first: no-ops when `donation.multi_currency` is off.
 */

import { FEATURE_FLAG_KEYS } from "@givernance/shared";
import {
  type BackfillFxRatePayload,
  FX_CACHE_JOBS,
  FX_CACHE_QUEUE_NAME,
} from "@givernance/shared/jobs";
import {
  auditLogs,
  bankAccounts,
  donationAllocations,
  donations,
  funds,
} from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { Queue } from "bullmq";
import { and, asc, eq, isNull } from "drizzle-orm";
import Redis from "ioredis";
import { env } from "../env.js";
import { db } from "../lib/db.js";
import { isFlagEnabled } from "../lib/flags.js";
import { jobLogger } from "../lib/logger.js";

const FIXER_BASE_URL = "https://data.fixer.io/api";
const BATCH_REQUEUE_DELAY_MS = 10 * 60 * 1000; // 10 minutes

interface FixerHistoricalResponse {
  success: boolean;
  timestamp?: number;
  base?: string;
  rates?: Record<string, number>;
  error?: { code: number; info: string };
}

type PendingDonation = {
  id: string;
  orgId: string;
  amountCents: number;
  currency: string;
  createdAt: Date;
};

/** Outcome of processing a single donation. */
type DonationOutcome = { kind: "resolved" } | { kind: "skipped" } | { kind: "fixer_unavailable" };

/** Format a Date as YYYY-MM-DD for the Fixer.io historical endpoint. */
function toFixerDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Create the fx_cache queue handle for self-scheduling. */
function createFxCacheQueue(): Queue {
  return new Queue(FX_CACHE_QUEUE_NAME, {
    connection: new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    }),
  });
}

/**
 * Resolve the settlement currency for a donation via the allocation chain.
 * Returns null when the chain is broken (skippable donation).
 */
async function resolveSettlementCurrency(
  donationId: string,
  log: ReturnType<typeof jobLogger>,
): Promise<string | null> {
  const [allocation] = await db
    .select({ fundId: donationAllocations.fundId })
    .from(donationAllocations)
    .where(eq(donationAllocations.donationId, donationId))
    .limit(1);

  if (!allocation) {
    log.warn({ donationId }, "backfill_fx_rate: no allocation found — skipping donation");
    return null;
  }

  const [fund] = await db
    .select({ bankAccountId: funds.bankAccountId })
    .from(funds)
    .where(eq(funds.id, allocation.fundId))
    .limit(1);

  if (!fund?.bankAccountId) {
    log.warn(
      { donationId, fundId: allocation.fundId },
      "backfill_fx_rate: fund has no bank account — skipping donation",
    );
    return null;
  }

  const [bankAccount] = await db
    .select({ currency: bankAccounts.currency })
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, fund.bankAccountId), isNull(bankAccounts.deletedAt)))
    .limit(1);

  if (!bankAccount) {
    log.warn(
      { donationId, bankAccountId: fund.bankAccountId },
      "backfill_fx_rate: bank account not found or deleted — skipping donation",
    );
    return null;
  }

  return bankAccount.currency.toUpperCase();
}

/**
 * Fetch the Fixer.io historical rate for a donation date and currency pair.
 * Returns null when Fixer.io is unavailable (caller aborts the batch).
 * Returns the rate or undefined when the API responds but the pair is missing.
 */
async function fetchHistoricalRate(
  donationId: string,
  donationCurrency: string,
  settlementCurrency: string,
  dateStr: string,
  log: ReturnType<typeof jobLogger>,
): Promise<{ rate: number; timestamp: Date } | null | "fixer_unavailable"> {
  const url = `${FIXER_BASE_URL}/${dateStr}?access_key=${env.FIXER_API_KEY}&base=${settlementCurrency}&symbols=${donationCurrency}`;

  let response: FixerHistoricalResponse;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) {
      throw new Error(`Fixer.io HTTP ${res.status} for ${dateStr}`);
    }
    response = (await res.json()) as FixerHistoricalResponse;
  } catch (err) {
    log.warn(
      {
        donationId,
        date: dateStr,
        settlementCurrency,
        err: err instanceof Error ? err.message : String(err),
      },
      "backfill_fx_rate: Fixer.io network error — aborting batch",
    );
    return "fixer_unavailable";
  }

  if (!response.success || !response.rates) {
    log.warn(
      { donationId, date: dateStr, settlementCurrency, error: response.error },
      "backfill_fx_rate: Fixer.io API error response — aborting batch",
    );
    return "fixer_unavailable";
  }

  const rate = response.rates[donationCurrency];
  if (rate === undefined || !Number.isFinite(rate) || rate <= 0) {
    log.warn(
      { donationId, donationCurrency, settlementCurrency, date: dateStr },
      "backfill_fx_rate: rate missing in Fixer.io response — skipping donation",
    );
    return null;
  }

  const timestamp = response.timestamp ? new Date(response.timestamp * 1000) : new Date(dateStr);
  return { rate, timestamp };
}

/** Process one donation from the batch. Returns the outcome. */
async function processDonation(
  donation: PendingDonation,
  log: ReturnType<typeof jobLogger>,
): Promise<DonationOutcome> {
  const settlementCurrency = await resolveSettlementCurrency(donation.id, log);
  if (!settlementCurrency) return { kind: "skipped" };

  const donationCurrency = donation.currency.toUpperCase();

  if (donationCurrency === settlementCurrency) {
    await resolveDonation(
      donation.id,
      donation.orgId,
      1.0,
      "same_currency",
      new Date(),
      donation.amountCents,
      log,
    );
    return { kind: "resolved" };
  }

  const dateStr = toFixerDate(donation.createdAt);
  const rateResult = await fetchHistoricalRate(
    donation.id,
    donationCurrency,
    settlementCurrency,
    dateStr,
    log,
  );

  if (rateResult === "fixer_unavailable") return { kind: "fixer_unavailable" };
  if (rateResult === null) return { kind: "skipped" };

  await resolveDonation(
    donation.id,
    donation.orgId,
    rateResult.rate,
    "backfilled",
    rateResult.timestamp,
    donation.amountCents,
    log,
  );
  return { kind: "resolved" };
}

export async function processBackfillFxRate(job: Job<BackfillFxRatePayload>): Promise<void> {
  const { triggeredBy } = job.data;
  const log = jobLogger({ jobId: job.id });

  log.info({ triggeredBy }, "backfill_fx_rate: starting");

  // Feature-flag gate
  const enabled = await isFlagEnabled(FEATURE_FLAG_KEYS.DONATION_MULTI_CURRENCY);
  if (!enabled) {
    log.info(
      { job: "backfill_fx_rate", triggeredBy },
      "backfill_fx_rate: flag donation.multi_currency off — skipping",
    );
    return;
  }

  if (!env.FIXER_API_KEY) {
    log.warn(
      { job: "backfill_fx_rate" },
      "backfill_fx_rate: FIXER_API_KEY not set — cannot fetch historical rates",
    );
    return;
  }

  const batchSize = env.BACKFILL_FX_BATCH_SIZE;

  // ── Fetch batch of fx_pending donations ────────────────────────────────────
  const pendingDonations = await db
    .select({
      id: donations.id,
      orgId: donations.orgId,
      amountCents: donations.amountCents,
      currency: donations.currency,
      createdAt: donations.createdAt,
    })
    .from(donations)
    .where(eq(donations.fxPending, true))
    .orderBy(asc(donations.createdAt))
    .limit(batchSize);

  if (pendingDonations.length === 0) {
    log.info({ triggeredBy }, "backfill_fx_rate: no fx_pending donations — done");
    return;
  }

  log.info(
    { triggeredBy, batchSize: pendingDonations.length },
    "backfill_fx_rate: processing batch",
  );

  let fixerAvailable = true;
  let resolvedCount = 0;

  for (const donation of pendingDonations) {
    if (!fixerAvailable) break;
    const outcome = await processDonation(donation, log);
    if (outcome.kind === "fixer_unavailable") {
      fixerAvailable = false;
      break;
    }
    if (outcome.kind === "resolved") resolvedCount++;
  }

  log.info(
    { triggeredBy, resolvedCount, batchSize: pendingDonations.length, fixerAvailable },
    "backfill_fx_rate: batch complete",
  );

  // If Fixer.io was unavailable, throw so BullMQ retries
  if (!fixerAvailable) {
    throw new Error("backfill_fx_rate: Fixer.io was unavailable — rethrowing for BullMQ retry");
  }

  // ── Self-schedule if more fx_pending rows remain ────────────────────────────
  if (pendingDonations.length >= batchSize) {
    const fxQueue = createFxCacheQueue();
    try {
      await fxQueue.add(
        FX_CACHE_JOBS.BACKFILL,
        { triggeredBy: "self" } satisfies BackfillFxRatePayload,
        {
          jobId: `backfill-fx-rate-self-${Date.now()}`,
          delay: BATCH_REQUEUE_DELAY_MS,
          attempts: 3,
          backoff: { type: "exponential", delay: 60_000 },
          removeOnComplete: { count: 10 },
          removeOnFail: { count: 50 },
        },
      );
      log.info(
        { delay: BATCH_REQUEUE_DELAY_MS },
        "backfill_fx_rate: more pending rows likely — re-enqueued with 10 min delay",
      );
    } finally {
      await fxQueue.close();
    }
  }
}

/**
 * Update a donation row with the resolved FX rate and write an audit log entry.
 * Runs via the owner-role pool (BYPASSRLS) — the processor is not tenant-scoped
 * and runs cross-tenant.
 */
async function resolveDonation(
  donationId: string,
  orgId: string,
  rate: number,
  source: string,
  rateTimestamp: Date,
  amountCents: number,
  log: ReturnType<typeof jobLogger>,
): Promise<void> {
  const amountInSettlementCurrencyCents = Math.round(amountCents * rate);

  await db
    .update(donations)
    .set({
      exchangeRate: String(rate),
      exchangeRateSource: source,
      exchangeRateTimestamp: rateTimestamp,
      amountInSettlementCurrencyCents,
      fxPending: false,
      updatedAt: new Date(),
    })
    .where(eq(donations.id, donationId));

  await db.insert(auditLogs).values({
    orgId,
    action: "donation.fx_backfilled",
    resourceType: "donation",
    resourceId: donationId,
    newValues: {
      exchangeRate: rate,
      source,
      timestamp: rateTimestamp.toISOString(),
      amountInSettlementCurrencyCents,
    },
  });

  log.info(
    { donationId, rate, source, amountInSettlementCurrencyCents },
    "backfill_fx_rate: donation resolved",
  );
}
