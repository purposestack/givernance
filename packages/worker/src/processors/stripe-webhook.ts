/** Job processor — handle Stripe webhook events asynchronously */

import type { ProcessStripeWebhookJob } from "@givernance/shared/jobs";
import {
  constituents,
  donations,
  outboxEvents,
  tenants,
  webhookEvents,
} from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { db, withWorkerContext } from "../lib/db.js";
import { jobLogger } from "../lib/logger.js";

/** Look up the tenant associated with a Stripe connected account ID */
async function findTenantByStripeAccount(stripeAccountId: string) {
  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.stripeAccountId, stripeAccountId));

  return tenant ?? null;
}

/**
 * Process a Stripe webhook event.
 * Currently handles: payment_intent.succeeded
 * Designed to be extended for additional event types (e.g. Mollie).
 */
export async function processStripeWebhook(
  job: Job<ProcessStripeWebhookJob["data"]>,
): Promise<void> {
  const { webhookEventId, stripeEventId, eventType, accountId, payload } = job.data;
  const log = jobLogger({ jobId: job.id, traceId: stripeEventId });

  log.info({ eventType, accountId }, "Processing Stripe webhook event");

  // Mark event as processing
  await db
    .update(webhookEvents)
    .set({ status: "processing" })
    .where(eq(webhookEvents.id, webhookEventId));

  try {
    if (eventType === "payment_intent.succeeded") {
      await handlePaymentIntentSucceeded(accountId, payload, log);
    } else {
      log.info({ eventType }, "Unhandled Stripe event type, marking completed");
    }

    // Mark event as completed
    await db
      .update(webhookEvents)
      .set({ status: "completed", processedAt: new Date() })
      .where(eq(webhookEvents.id, webhookEventId));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    log.error({ err: message, eventType }, "Failed to process Stripe webhook event");

    await db
      .update(webhookEvents)
      .set({ status: "failed", error: message })
      .where(eq(webhookEvents.id, webhookEventId));

    throw err;
  }
}

/**
 * Handle payment_intent.succeeded — create a donation record for the tenant.
 * Resolves the tenant from the connected account ID, finds or creates the constituent,
 * and records the donation atomically with a DonationCreated outbox event.
 */
async function handlePaymentIntentSucceeded(
  accountId: string | null,
  payload: Record<string, unknown>,
  log: ReturnType<typeof jobLogger>,
): Promise<void> {
  if (!accountId) {
    log.warn("payment_intent.succeeded without account_id, skipping");
    return;
  }

  // Resolve the tenant from the Stripe connected account
  const tenant = await findTenantByStripeAccount(accountId);
  if (!tenant) {
    throw new Error(`No tenant found for Stripe account ${accountId}`);
  }

  const orgId = tenant.id;
  const amountCents = (payload.amount as number) ?? 0;
  const currency = ((payload.currency as string) ?? "eur").toUpperCase();
  const paymentIntentId = payload.id as string;
  const metadata = (payload.metadata as Record<string, string>) ?? {};
  const constituentEmail = payload.receipt_email || metadata.constituent_email;
  const constituentFirstName = metadata.constituent_first_name ?? "Anonymous";
  const constituentLastName = metadata.constituent_last_name ?? "Donor";
  const campaignId = metadata.campaign_id || null;

  await withWorkerContext(orgId, async (tx) => {
    // Find or create constituent
    let constituentId: string;

    if (constituentEmail) {
      const [existing] = await tx
        .select({ id: constituents.id })
        .from(constituents)
        .where(
          sql`${constituents.orgId} = ${orgId} AND ${constituents.email} = ${constituentEmail}`,
        );

      if (existing) {
        constituentId = existing.id;
      } else {
        const [created] = await tx
          .insert(constituents)
          .values({
            orgId,
            firstName: constituentFirstName,
            lastName: constituentLastName,
            email: constituentEmail,
            type: "donor",
          })
          .returning({ id: constituents.id });
        // biome-ignore lint/style/noNonNullAssertion: insert returning always returns
        constituentId = created!.id;
        log.info({ constituentId }, "Created new constituent from Stripe");
      }
    } else {
      // No email provided — create anonymous constituent
      const [created] = await tx
        .insert(constituents)
        .values({
          orgId,
          firstName: constituentFirstName,
          lastName: constituentLastName,
          type: "donor",
        })
        .returning({ id: constituents.id });
      // biome-ignore lint/style/noNonNullAssertion: insert returning always returns
      constituentId = created!.id;
    }

    // Create the donation record — ON CONFLICT guards against BullMQ retry duplicates
    const [donation] = await tx
      .insert(donations)
      .values({
        orgId,
        constituentId,
        amountCents,
        currency,
        campaignId: campaignId || undefined,
        paymentMethod: "stripe",
        paymentRef: paymentIntentId,
        donatedAt: new Date(),
        fiscalYear: new Date().getFullYear(),
      })
      .onConflictDoNothing()
      .returning();

    if (!donation) {
      log.info({ paymentRef: paymentIntentId }, "Donation already exists (retry), skipping");
      return;
    }

    const donationId = donation.id;

    // Emit DonationCreated domain event atomically
    await tx.insert(outboxEvents).values({
      tenantId: orgId,
      type: "donation.created",
      payload: {
        donationId,
        constituentId,
        amountCents,
        currency,
        paymentMethod: "stripe",
        paymentRef: paymentIntentId,
        source: "stripe_webhook",
      },
    });

    log.info(
      { donationId, constituentId, amountCents, currency },
      "Donation created from Stripe payment_intent.succeeded",
    );
  });
}
