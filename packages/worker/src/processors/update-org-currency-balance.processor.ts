/**
 * Update org_currency_balances — materialized running totals per
 * (org, currency) pair (ADR-032 §2.10, Epic #416 Task 6).
 *
 * Called for every donation lifecycle event that changes cleared/pending totals.
 * The signed deltas are derived from the ACTUAL status transition carried on the
 * event payload — never from an assumed prior state:
 *
 *   donation.created     status=cleared              → +cleared
 *   donation.created     status=pending              → +pending
 *   donation.refunded    priorStatus=cleared         → −cleared
 *   donation.refunded    priorStatus=pending         → −pending
 *   donation.status_changed (fromStatus→toStatus)    → leaving bucket −delta +
 *                                                       arriving bucket +delta
 *
 * When the transition data needed to compute a correct delta is absent (an older
 * enqueued job, or a producer that didn't carry priorStatus / from/to), the
 * processor logs a warning and NO-OPS rather than guessing — a missed update is
 * recoverable by recompute; a wrong delta silently corrupts the totals.
 *
 * The upsert uses signed integer deltas so a refund passes a negative delta and
 * the ON CONFLICT UPDATE expression naturally subtracts:
 *
 *   cleared_total_cents = org_currency_balances.cleared_total_cents + EXCLUDED.cleared_total_cents
 *
 * Idempotency: BullMQ jobId (`currency-balance-{donationId}-{eventType}`) dedups
 * outbox relay re-deliveries at ENQUEUE time. (At-least-once *execution* — a crash
 * between the committed upsert and the BullMQ ack — can still re-apply a delta; an
 * idempotency ledger is tracked as a follow-up.)
 *
 * DB access: the upsert runs via the owner pool (`db`, BYPASSRLS) so the INSERT can
 * reach across tenant boundaries — the `org_id` column value constrains the written
 * row. Fetching the donation uses `withWorkerContext` (app-role + RLS) so a stale
 * `donationId` from another tenant cannot be read.
 */

import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import type {
  DonationBalanceStatus,
  UpdateOrgCurrencyBalancePayload,
} from "@givernance/shared/jobs";
import { donations, orgCurrencyBalances } from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { and, eq, sql } from "drizzle-orm";
import { db, withWorkerContext } from "../lib/db.js";
import { isFlagEnabled } from "../lib/flags.js";
import { jobLogger } from "../lib/logger.js";

/** Signed deltas to apply to (cleared, pending) for one event. */
export type BalanceDelta = { clearedDelta: number; pendingDelta: number };

/** +delta into the bucket a donation with `status` contributes to (cleared/pending). */
function enterBucket(status: DonationBalanceStatus | undefined, amountCents: number): BalanceDelta {
  if (status === "cleared") return { clearedDelta: amountCents, pendingDelta: 0 };
  if (status === "pending") return { clearedDelta: 0, pendingDelta: amountCents };
  return { clearedDelta: 0, pendingDelta: 0 };
}

/** −delta out of the bucket a donation with `status` was contributing to. */
function leaveBucket(status: DonationBalanceStatus | undefined, amountCents: number): BalanceDelta {
  if (status === "cleared") return { clearedDelta: -amountCents, pendingDelta: 0 };
  if (status === "pending") return { clearedDelta: 0, pendingDelta: -amountCents };
  return { clearedDelta: 0, pendingDelta: 0 };
}

/**
 * Pure decision logic for the balance delta (B2, ADR-032 §2.10). Returns `null`
 * when there isn't enough information to compute a CORRECT delta — the caller
 * then no-ops rather than guessing (a missed update is recoverable; a wrong
 * delta silently corrupts the totals). Exported for unit testing.
 *
 * @param currentStatus the donation row's status NOW (the entered bucket for `created`)
 */
export function computeBalanceDelta(
  input: Pick<
    UpdateOrgCurrencyBalancePayload,
    "eventType" | "priorStatus" | "fromStatus" | "toStatus"
  >,
  amountCents: number,
  currentStatus: DonationBalanceStatus | undefined,
): BalanceDelta | null {
  const { eventType, priorStatus, fromStatus, toStatus } = input;

  if (eventType === "donation.created") {
    // The donation's current status IS the entered bucket at creation time.
    return enterBucket(currentStatus, amountCents);
  }

  if (eventType === "donation.refunded") {
    // Subtract from whichever bucket the donation was in BEFORE the refund.
    // The row now reads `refunded`, so `priorStatus` is the only authority.
    if (!priorStatus) return null;
    return leaveBucket(priorStatus, amountCents);
  }

  // donation.status_changed — leaving bucket's −delta + arriving bucket's +delta.
  if (!fromStatus || !toStatus) return null;
  const out = leaveBucket(fromStatus, amountCents);
  const into = enterBucket(toStatus, amountCents);
  return {
    clearedDelta: out.clearedDelta + into.clearedDelta,
    pendingDelta: out.pendingDelta + into.pendingDelta,
  };
}

export async function processUpdateOrgCurrencyBalance(
  job: Job<UpdateOrgCurrencyBalancePayload>,
): Promise<void> {
  const { orgId, donationId, eventType, priorStatus, fromStatus, toStatus } = job.data;

  const log = jobLogger({ tenantId: orgId, jobId: job.id });

  // Feature-flag gate (defence in depth — the worker is the second wall if a
  // request slipped past the API gate). No-op when multi-currency is off.
  if (!(await isFlagEnabled(FEATURE_FLAG_KEYS.DONATION_MULTI_CURRENCY))) {
    log.info({ donationId, eventType }, "balance update skipped — multi_currency flag off");
    return;
  }

  log.info({ donationId, eventType }, "Updating org currency balance");

  // Fetch donation under RLS — the app-role pool ensures we can only read
  // donations belonging to `orgId`. If the row is missing (race with a
  // hard-delete or a bad payload) we bail cleanly without error so BullMQ
  // doesn't retry indefinitely.
  const donationRow = await withWorkerContext(orgId, async (tx) => {
    const [row] = await tx
      .select({
        amountCents: donations.amountCents,
        currency: donations.currency,
        status: donations.status,
      })
      .from(donations)
      .where(and(eq(donations.id, donationId), eq(donations.orgId, orgId)));
    return row ?? null;
  });

  if (!donationRow) {
    log.warn({ donationId, orgId }, "Donation not found — skipping balance update");
    return;
  }

  const { amountCents, currency, status } = donationRow;

  // Compute signed deltas from the ACTUAL transition carried on the event.
  // `null` ⇒ not enough information for a correct delta ⇒ safe no-op (B2).
  const delta = computeBalanceDelta(
    { eventType, priorStatus, fromStatus, toStatus },
    amountCents,
    status as DonationBalanceStatus,
  );

  if (!delta) {
    log.warn(
      { donationId, eventType, priorStatus, fromStatus, toStatus },
      "balance event lacks the transition data to compute a correct delta — skipping",
    );
    return;
  }

  if (delta.clearedDelta === 0 && delta.pendingDelta === 0) {
    log.debug({ donationId, eventType, status }, "No balance delta — skipping upsert");
    return;
  }

  // Upsert via owner pool (BYPASSRLS) — the worker has no org context set at the
  // pool level; the org_id column value itself constrains which row is touched.
  await db
    .insert(orgCurrencyBalances)
    .values({
      orgId,
      currency,
      clearedTotalCents: delta.clearedDelta,
      pendingTotalCents: delta.pendingDelta,
      updatedAt: sql`NOW()`,
    })
    .onConflictDoUpdate({
      target: [orgCurrencyBalances.orgId, orgCurrencyBalances.currency],
      set: {
        clearedTotalCents: sql`${orgCurrencyBalances.clearedTotalCents} + EXCLUDED.cleared_total_cents`,
        pendingTotalCents: sql`${orgCurrencyBalances.pendingTotalCents} + EXCLUDED.pending_total_cents`,
        updatedAt: sql`NOW()`,
      },
    });

  log.info({ donationId, orgId, currency, ...delta }, "Org currency balance updated");
}
