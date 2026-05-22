/**
 * Update org_currency_balances — materialized running totals per
 * (org, currency) pair (ADR-031 §2.10, Epic #416 Task 6).
 *
 * Called for every domain event that changes the cleared/pending
 * donation totals:
 *
 *   donation.created     status=cleared → +clearedTotalCents
 *   donation.created     status=pending → +pendingTotalCents
 *   donation.refunded                  → -clearedTotalCents
 *   donation.status_changed            → +clearedTotalCents, -pendingTotalCents
 *                                        (models the pending→cleared transition)
 *
 * The upsert uses signed integer deltas so a refund passes a negative
 * clearedDelta and the ON CONFLICT UPDATE expression naturally subtracts:
 *
 *   cleared_total_cents = org_currency_balances.cleared_total_cents + EXCLUDED.cleared_total_cents
 *
 * Idempotency: BullMQ job deduplication via a stable jobId
 * (`currency-balance-{donationId}-{eventType}`) prevents the same event
 * from being processed twice even if the outbox relay retries.
 *
 * DB access: the upsert runs via the owner role (BYPASSRLS) using `db`
 * so the INSERT can reach across tenant boundaries — the `org_id` column
 * enforces the correct tenant scope on the written row. Fetching the
 * donation uses `withWorkerContext` (app-role + RLS) so a stale
 * `donationId` from another tenant cannot be read.
 */

import type { UpdateOrgCurrencyBalancePayload } from "@givernance/shared/jobs";
import { donations, orgCurrencyBalances } from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { and, eq, sql } from "drizzle-orm";
import { db, withWorkerContext } from "../lib/db.js";
import { jobLogger } from "../lib/logger.js";

export async function processUpdateOrgCurrencyBalance(
  job: Job<UpdateOrgCurrencyBalancePayload>,
): Promise<void> {
  const { orgId, donationId, eventType } = job.data;

  const log = jobLogger({ tenantId: orgId, jobId: job.id });
  log.info({ donationId, eventType }, "Updating org currency balance");

  // Fetch donation under RLS — the app-role pool ensures we can only
  // read donations belonging to `orgId`. If the row is missing (race
  // with a hard-delete or a bad payload) we bail cleanly without error
  // so BullMQ doesn't retry indefinitely.
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

  // Compute signed deltas based on the event and the donation's current status.
  let clearedDelta = 0;
  let pendingDelta = 0;

  if (eventType === "donation.created") {
    if (status === "cleared") {
      clearedDelta = amountCents;
    } else if (status === "pending") {
      pendingDelta = amountCents;
    }
    // status=failed or status=refunded on creation → no balance change
  } else if (eventType === "donation.refunded") {
    clearedDelta = -amountCents;
  } else if (eventType === "donation.status_changed") {
    // Models the standard pending→cleared transition. The delta is:
    //   +cleared (the amount now counts as cleared)
    //   -pending (it was previously counted as pending)
    clearedDelta = amountCents;
    pendingDelta = -amountCents;
  }

  if (clearedDelta === 0 && pendingDelta === 0) {
    log.debug({ donationId, eventType, status }, "No balance delta — skipping upsert");
    return;
  }

  // Upsert via owner role (BYPASSRLS) — the worker does not have an
  // org context set at the pool level; the org_id column value itself
  // constrains which row is touched.
  await db
    .insert(orgCurrencyBalances)
    .values({
      orgId,
      currency,
      clearedTotalCents: clearedDelta,
      pendingTotalCents: pendingDelta,
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

  log.info(
    { donationId, orgId, currency, clearedDelta, pendingDelta },
    "Org currency balance updated",
  );
}
