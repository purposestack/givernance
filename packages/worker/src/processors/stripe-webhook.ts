/** Job processor — handle Stripe webhook events asynchronously */

import { ExchangeRateService } from "@givernance/shared";
import type { ProcessStripeWebhookJob } from "@givernance/shared/jobs";
import {
  auditLogs,
  campaigns,
  constituents,
  donations,
  outboxEvents,
  tenants,
  webhookEvents,
} from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { and, eq, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { env } from "../env.js";
import { db, withWorkerContext } from "../lib/db.js";
import { jobLogger } from "../lib/logger.js";

/**
 * Type-safe coercion of the BullMQ-serialised payload back into a Stripe
 * resource shape. The wire format is `Record<string, unknown>` (BullMQ
 * doesn't preserve class types), but every event Stripe sends carries a
 * documented shape — we cast through `unknown` and validate the fields we
 * actually read so a malformed event DLQs loudly instead of silently
 * inserting a €0 donation.
 */
function asPaymentIntent(payload: Record<string, unknown>): Stripe.PaymentIntent {
  if (typeof payload.id !== "string" || typeof payload.amount !== "number") {
    throw new Error(
      `Malformed payment_intent payload: id=${typeof payload.id}, amount=${typeof payload.amount}`,
    );
  }
  return payload as unknown as Stripe.PaymentIntent;
}

function asCharge(payload: Record<string, unknown>): Stripe.Charge {
  if (typeof payload.id !== "string" || typeof payload.payment_intent !== "string") {
    throw new Error(
      `Malformed charge payload: id=${typeof payload.id}, payment_intent=${typeof payload.payment_intent}`,
    );
  }
  return payload as unknown as Stripe.Charge;
}

function asAccount(payload: Record<string, unknown>): Stripe.Account {
  if (typeof payload.id !== "string") {
    throw new Error(`Malformed account payload: id=${typeof payload.id}`);
  }
  return payload as unknown as Stripe.Account;
}

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
 * Handles: payment_intent.succeeded, charge.refunded, account.updated.
 * Other event types are acknowledged + marked completed without action so the
 * `webhook_events` row carries an audit trail of "we saw it" without forcing
 * a retry storm; extend the routing block below to handle new types.
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
      await handlePaymentIntentSucceeded(accountId, asPaymentIntent(payload), log);
    } else if (eventType === "charge.refunded") {
      await handleChargeRefunded(accountId, asCharge(payload), log);
    } else if (eventType === "account.updated") {
      await handleAccountUpdated(asAccount(payload), log);
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
  intent: Stripe.PaymentIntent,
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
  const amountCents = intent.amount;
  const currency = (intent.currency ?? "eur").toUpperCase();
  const paymentIntentId = intent.id;
  const metadata = intent.metadata ?? {};
  const constituentEmail = intent.receipt_email ?? metadata.constituent_email ?? undefined;
  const constituentFirstName = metadata.constituent_first_name ?? "Anonymous";
  const constituentLastName = metadata.constituent_last_name ?? "Donor";
  const campaignId = metadata.campaign_id || null;
  const platformFeeCents = intent.application_fee_amount ?? 0;

  await withWorkerContext(orgId, async (tx) => {
    const exchangeRateService = new ExchangeRateService({
      apiKey: env.EXCHANGE_RATE_API_KEY,
      dbClient: tx,
      logger: log,
    });
    const baseCurrency = await exchangeRateService.getOrgBaseCurrency(orgId);
    const convertedAmount = await exchangeRateService.convertAmountCents(
      amountCents,
      currency,
      baseCurrency,
    );

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
        exchangeRate: convertedAmount.exchangeRate.toFixed(8),
        amountBaseCents: convertedAmount.amountBaseCents,
        campaignId: campaignId || undefined,
        status: "cleared",
        platformFeeCents,
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

    if (campaignId) {
      // Defence-in-depth: `campaignId` came from PaymentIntent metadata, which
      // the platform sets server-side today but is technically attacker-tainted
      // (a hand-crafted PI created via Stripe dashboard on the same connected
      // account could carry a `metadata.campaign_id` for a campaign on a
      // different tenant). RLS catches it via `withWorkerContext(orgId)`, but
      // the explicit `org_id` filter makes the query refuse to write across
      // tenants even if the RLS context were ever wrong.
      await tx
        .update(campaigns)
        .set({
          platformFeesCents: sql`${campaigns.platformFeesCents} + ${platformFeeCents}`,
          updatedAt: new Date(),
        })
        .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)));
    }

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
      {
        amountBaseCents: convertedAmount.amountBaseCents,
        baseCurrency,
        constituentId,
        currency,
        donationId,
        exchangeRate: convertedAmount.exchangeRate,
        amountCents,
      },
      "Donation created from Stripe payment_intent.succeeded",
    );
  });
}

/**
 * Handle charge.refunded — flip the donation status to `refunded` and roll
 * back the platform-fee accumulator on the campaign. Stripe's default on
 * direct charges is to refund the application fee alongside the charge
 * when our `refunds.create` call passes `refund_application_fee: true`
 * (see donations refund route), so the platform fee returns to the NPO's
 * balance and we mirror that on our side.
 *
 * Idempotent against retries: if the donation is already `refunded`,
 * the update is a no-op (filter on `status != 'refunded'` for the campaign
 * fee decrement so we don't double-decrement on a webhook replay).
 */
async function handleChargeRefunded(
  accountId: string | null,
  charge: Stripe.Charge,
  log: ReturnType<typeof jobLogger>,
): Promise<void> {
  if (!accountId) {
    log.warn("charge.refunded without account_id, skipping");
    return;
  }

  const tenant = await findTenantByStripeAccount(accountId);
  if (!tenant) {
    throw new Error(`No tenant found for Stripe account ${accountId}`);
  }
  const orgId = tenant.id;

  const paymentIntentId =
    typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  if (!paymentIntentId) {
    log.warn({ chargeId: charge.id }, "charge.refunded without payment_intent, skipping");
    return;
  }

  await withWorkerContext(orgId, async (tx) => {
    // Resolve the donation we recorded on the original `payment_intent.succeeded`.
    // Filtering by orgId is belt-and-braces under RLS — same defence-in-depth
    // pattern as the campaign update on the success path.
    const [donation] = await tx
      .select({
        id: donations.id,
        status: donations.status,
        campaignId: donations.campaignId,
        platformFeeCents: donations.platformFeeCents,
      })
      .from(donations)
      .where(and(eq(donations.paymentRef, paymentIntentId), eq(donations.orgId, orgId)));

    if (!donation) {
      log.warn(
        { paymentIntentId },
        "charge.refunded for unknown payment_intent, skipping (Stripe-only charge?)",
      );
      return;
    }

    if (donation.status === "refunded") {
      log.info({ donationId: donation.id }, "Donation already marked refunded, skipping");
      return;
    }

    await tx
      .update(donations)
      .set({ status: "refunded" })
      .where(and(eq(donations.id, donation.id), eq(donations.orgId, orgId)));

    if (donation.campaignId && donation.platformFeeCents > 0) {
      await tx
        .update(campaigns)
        .set({
          platformFeesCents: sql`GREATEST(${campaigns.platformFeesCents} - ${donation.platformFeeCents}, 0)`,
          updatedAt: new Date(),
        })
        .where(and(eq(campaigns.id, donation.campaignId), eq(campaigns.orgId, orgId)));
    }

    // Emit DonationRefunded domain event so receipts / reporting can react.
    await tx.insert(outboxEvents).values({
      tenantId: orgId,
      type: "donation.refunded",
      payload: {
        donationId: donation.id,
        paymentRef: paymentIntentId,
        source: "stripe_webhook",
      },
    });

    // Audit trail (PR #193 review, finding #9). The API plugin already
    // logs the operator who hit POST /v1/donations/:id/refund — but a
    // refund initiated from the NPO's Stripe dashboard skips that path
    // entirely, and the worker-side state change had no audit trace.
    // `userId` / `actorId` null = system-initiated; the previous +
    // resulting status are recorded so a forensic reader can reconstruct
    // who-flipped-what without joining against the original API request.
    await tx.insert(auditLogs).values({
      orgId,
      userId: null,
      actorId: null,
      action: "WEBHOOK:charge.refunded",
      resourceType: "donations",
      resourceId: donation.id,
      oldValues: { status: "cleared" },
      newValues: {
        status: "refunded",
        chargeId: charge.id,
        paymentIntentId,
      },
    });

    log.info(
      { donationId: donation.id, paymentIntentId, chargeId: charge.id },
      "Donation refunded from Stripe charge.refunded",
    );
  });
}

/**
 * Handle `account.updated` (issue #62). Caches the connected account's
 * `charges_enabled` / `payouts_enabled` / `details_submitted` flags onto
 * the matching tenant row so the donor flow can flip from test mode to
 * live mode without a per-page-load `accounts.retrieve` round-trip.
 *
 * "Auto-switch to live mode" in doc-20 §5.2 = persisting
 * `stripe_charges_enabled = true`. Downstream consumers (donor flow,
 * platform-finance dashboard) read the cached column instead of calling
 * Stripe live; the cached snapshot is refreshed on every `account.updated`
 * webhook so it never lags behind by more than a few seconds in healthy
 * deployments.
 *
 * Stripe sends `account.updated` events without a top-level `account` id —
 * the connected account whose state changed is the event payload itself
 * (`event.data.object.id`). The handler resolves the tenant by that id;
 * a missing tenant row is logged but not thrown so a webhook for a
 * connected account that we no longer own (e.g. mid-migration) doesn't
 * DLQ the queue.
 */
async function handleAccountUpdated(
  account: Stripe.Account,
  log: ReturnType<typeof jobLogger>,
): Promise<void> {
  const stripeAccountId = account.id;

  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.stripeAccountId, stripeAccountId));

  if (!tenant) {
    log.warn({ stripeAccountId }, "account.updated for unknown connected account, skipping");
    return;
  }

  const chargesEnabled = Boolean(account.charges_enabled);
  const payoutsEnabled = Boolean(account.payouts_enabled);
  const detailsSubmitted = Boolean(account.details_submitted);

  await db
    .update(tenants)
    .set({
      stripeChargesEnabled: chargesEnabled,
      stripePayoutsEnabled: payoutsEnabled,
      stripeDetailsSubmitted: detailsSubmitted,
      stripeAccountStateAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(tenants.id, tenant.id));

  log.info(
    {
      orgId: tenant.id,
      stripeAccountId,
      chargesEnabled,
      payoutsEnabled,
      detailsSubmitted,
    },
    "Cached Stripe account.updated state on tenant",
  );
}
