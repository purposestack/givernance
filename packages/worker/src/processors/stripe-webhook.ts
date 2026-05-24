/** Job processor — handle Stripe webhook events asynchronously */

import { ExchangeRateService } from "@givernance/shared";
import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import type { ProcessStripeWebhookJob } from "@givernance/shared/jobs";
import {
  auditLogs,
  campaignQrCodes,
  campaigns,
  constituents,
  donations,
  outboxEvents,
  paymentAttempts,
  tenants,
  webhookEvents,
} from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { and, eq, sql } from "drizzle-orm";
import Stripe from "stripe";
import { env } from "../env.js";
import { db, withWorkerContext } from "../lib/db.js";
import { isFlagEnabled } from "../lib/flags.js";
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

/**
 * Epic #274 — re-verify the QR id under RLS before trusting it. Returns
 * null when the metadata referenced a token that has since been deleted
 * (rare but defensible — admin closes campaign + cascades QR rows mid-
 * payment), or when metadata was tampered to point at a different
 * tenant's QR row (RLS makes this query empty). The constituent fallback
 * is the metadata value, kept for back-compat with legacy bound rows.
 *
 * Pulled out of `handlePaymentIntentSucceeded` to keep that function
 * under the cognitive-complexity threshold; behaviour-preserving.
 */
async function resolveQrLink(
  tx: Parameters<Parameters<typeof withWorkerContext>[1]>[0],
  orgId: string,
  metadata: { qrCodeId: string | null; qrCodeConstituentId: string | null },
): Promise<{ resolvedQrCodeId: string | null; qrLinkedConstituentId: string | null }> {
  if (!metadata.qrCodeId) {
    return { resolvedQrCodeId: null, qrLinkedConstituentId: null };
  }
  const [qr] = await tx
    .select({
      id: campaignQrCodes.id,
      constituentId: campaignQrCodes.constituentId,
    })
    .from(campaignQrCodes)
    .where(and(eq(campaignQrCodes.id, metadata.qrCodeId), eq(campaignQrCodes.orgId, orgId)));
  if (!qr) {
    return { resolvedQrCodeId: null, qrLinkedConstituentId: null };
  }
  return {
    resolvedQrCodeId: qr.id,
    qrLinkedConstituentId: qr.constituentId ?? metadata.qrCodeConstituentId,
  };
}

/**
 * Find or create the donor constituent. Walks three resolution strategies
 * in order: (1) QR-linked id (postal letter recipient — protects per-
 * recipient analytics from "Jean Dupont's wife paid online" producing a
 * brand-new row), (2) email match (drops the donor on their existing
 * record), (3) anonymous create (no email, no QR). Pulled out of
 * `handlePaymentIntentSucceeded` to keep that function under the
 * cognitive-complexity threshold.
 */
async function findOrCreateConstituent(
  tx: Parameters<Parameters<typeof withWorkerContext>[1]>[0],
  orgId: string,
  args: {
    qrLinkedConstituentId: string | null;
    email: string | null;
    firstName: string;
    lastName: string;
    log: ReturnType<typeof jobLogger>;
  },
): Promise<string> {
  const { qrLinkedConstituentId, email, firstName, lastName, log } = args;

  if (qrLinkedConstituentId) {
    const [linked] = await tx
      .select({ id: constituents.id })
      .from(constituents)
      .where(and(eq(constituents.id, qrLinkedConstituentId), eq(constituents.orgId, orgId)));
    if (linked) return linked.id;
    // The linked constituent was deleted between print and scan — fall through.
  }

  if (email) {
    const [existing] = await tx
      .select({ id: constituents.id })
      .from(constituents)
      .where(sql`${constituents.orgId} = ${orgId} AND ${constituents.email} = ${email}`);
    if (existing) return existing.id;

    const [created] = await tx
      .insert(constituents)
      .values({ orgId, firstName, lastName, email, type: "donor" })
      .returning({ id: constituents.id });
    if (!created) throw new Error("findOrCreateConstituent: insert returned no row");
    log.info({ constituentId: created.id }, "Created new constituent from Stripe");
    return created.id;
  }

  // No email AND no QR — anonymous constituent.
  const [created] = await tx
    .insert(constituents)
    .values({ orgId, firstName, lastName, type: "donor" })
    .returning({ id: constituents.id });
  if (!created) throw new Error("findOrCreateConstituent: insert returned no row");
  return created.id;
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
 * Handles: payment_intent.succeeded, charge.refunded.
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
    } else if (eventType === "payment_intent.payment_failed") {
      // #436 — feeds the dashboard's payment-failure-rate KPI. The
      // donation-creation path is intentionally NOT invoked here; a
      // failed PI never produces a donations row.
      await handlePaymentIntentFailed(accountId, asPaymentIntent(payload), log);
    } else if (eventType === "charge.refunded") {
      await handleChargeRefunded(accountId, asCharge(payload), log);
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
  // Epic #274 — QR-attributed donations carry their `qr_code_id` in PI
  // metadata, set server-side at intent creation. We trust the value
  // because the public API resolved the opaque token against the
  // (org, campaign) pair before stamping it; we still re-verify under
  // RLS below before writing it onto the donation.
  const qrCodeIdFromMetadata = metadata.qr_code_id || null;
  const qrCodeConstituentIdFromMetadata = metadata.qr_code_constituent_id || null;
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

    // Convert the platform-fee cents into the org's base currency using
    // the SAME exchange rate snapshot that produced `amountBaseCents`,
    // so the dashboard KPI (`platform_fee_base_cents` summed by tenant)
    // stays consistent with `amount_base_cents`. Migration 0065
    // backfilled historical rows; without this line, every ongoing
    // insert would default to 0 and silently regress the KPI.
    const platformFeeBaseCents = Math.round(platformFeeCents * convertedAmount.exchangeRate);

    const { resolvedQrCodeId, qrLinkedConstituentId } = await resolveQrLink(tx, orgId, {
      qrCodeId: qrCodeIdFromMetadata,
      qrCodeConstituentId: qrCodeConstituentIdFromMetadata,
    });
    const constituentId = await findOrCreateConstituent(tx, orgId, {
      qrLinkedConstituentId,
      email: constituentEmail ?? null,
      firstName: constituentFirstName,
      lastName: constituentLastName,
      log,
    });

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
        qrCodeId: resolvedQrCodeId ?? undefined,
        status: "cleared",
        platformFeeCents,
        platformFeeBaseCents,
        paymentMethod: "stripe",
        paymentRef: paymentIntentId,
        donatedAt: new Date(),
        fiscalYear: new Date().getFullYear(),
      })
      .onConflictDoNothing()
      .returning();

    if (!donation) {
      log.info({ paymentRef: paymentIntentId }, "Donation already exists (retry), skipping");
      // #436 — even on a no-op donation insert (BullMQ retry), ensure
      // the corresponding payment_attempts row exists so the dashboard
      // KPI denominator is honest. UPSERT keyed on
      // `stripe_payment_intent_id` (UNIQUE) — see migration 0070.
      await upsertPaymentAttempt(tx, orgId, {
        intentId: paymentIntentId,
        amountCents,
        currency,
        status: "succeeded",
        failureCode: null,
        failureMessage: null,
        outcomeReason: null,
      });
      return;
    }

    const donationId = donation.id;

    // #436 — record the successful payment attempt. Peer to the donation
    // write (succeeded intents appear in both `donations` and
    // `payment_attempts` so the failure-rate KPI's denominator includes
    // every attempt we observed).
    await upsertPaymentAttempt(tx, orgId, {
      intentId: paymentIntentId,
      amountCents,
      currency,
      status: "succeeded",
      failureCode: null,
      failureMessage: null,
      outcomeReason: null,
    });

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

    // Audit trail for QR-attributed donations (Epic #274 audit follow-up).
    // Mirrors the asymmetric pattern used by `charge.refunded` below: when
    // a donation is reconciled by a webhook (no operator clicked anything),
    // `userId` / `actorId` are NULL so a forensic reader knows the state
    // change came from the system. The QR id lives in `new_values` so a
    // reviewer can join back to `campaign_qr_codes` and reconstruct the
    // print → scan → donate chain without trusting Stripe metadata alone.
    //
    // Only emitted when we actually resolved a QR id under RLS — a vanilla
    // (non-postal) Stripe donation has no QR provenance worth auditing,
    // and we don't want to dilute the audit log with one row per gift.
    if (resolvedQrCodeId) {
      await tx.insert(auditLogs).values({
        orgId,
        userId: null,
        actorId: null,
        action: "WEBHOOK:donation.qr_attributed",
        resourceType: "donations",
        resourceId: donationId,
        oldValues: null,
        newValues: {
          status: "cleared",
          amountCents,
          currency,
          qrCodeId: resolvedQrCodeId,
          campaignId: campaignId || null,
          paymentIntentId,
          source: "stripe_webhook",
        },
      });
    }

    // #436 — Stripe BalanceTransaction fee enrichment. Gated by the
    // `admin.finance_dashboard` flag: when off, we still process the
    // donation normally — the column `donations.stripe_fee_cents`
    // simply stays NULL and the dashboard's "Revenu Givernance" KPI
    // falls back to the platform-fee accumulator without the
    // Stripe-side processing-fee deduction. The Stripe SDK call is
    // wrapped in try/catch — enrichment is best-effort, not
    // transactional.
    await maybeEnrichStripeFee(tx, {
      orgId,
      donationId,
      intent,
      stripeAccountId: accountId,
      targetCurrency: baseCurrency,
      paymentIntentId,
      log,
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
        qrCodeId: resolvedQrCodeId,
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
      .set({
        status: "refunded",
        // #436 — distinct from updated_at so the dashboard's refund-rate
        // KPI can scope by refund date (when the chargeback hit), not
        // donation date (when the original gift cleared).
        refundedAt: new Date(),
      })
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

// ─── #436 — payment_attempts upsert + failed-intent handler ────────────────

interface PaymentAttemptInput {
  intentId: string;
  amountCents: number;
  currency: string;
  status: "succeeded" | "failed" | "requires_action";
  failureCode: string | null;
  failureMessage: string | null;
  outcomeReason: string | null;
}

/**
 * UPSERT a `payment_attempts` row keyed on `stripe_payment_intent_id`
 * (the migration 0070 unique constraint). Called from both the
 * `payment_intent.succeeded` and `payment_intent.payment_failed`
 * handlers; the dashboard's payment-failure-rate KPI reads
 * `numerator / denominator` from this table directly.
 *
 * Always carries `eq(paymentAttempts.orgId, orgId)` on the conflict
 * resolution and an explicit `orgId` field on insert — defence-in-depth
 * even inside `withWorkerContext`.
 */
async function upsertPaymentAttempt(
  tx: Parameters<Parameters<typeof withWorkerContext>[1]>[0],
  orgId: string,
  input: PaymentAttemptInput,
): Promise<void> {
  await tx
    .insert(paymentAttempts)
    .values({
      orgId,
      stripePaymentIntentId: input.intentId,
      currency: input.currency,
      amountCents: input.amountCents,
      status: input.status,
      failureCode: input.failureCode,
      failureMessage: input.failureMessage,
      outcomeReason: input.outcomeReason,
    })
    .onConflictDoUpdate({
      target: paymentAttempts.stripePaymentIntentId,
      // Stripe's terminal states are monotonic per intent, BUT webhook
      // redeliveries are NOT — a stale `payment_intent.payment_failed`
      // can land after the `payment_intent.succeeded` that promoted the
      // row. Guard the update with `status != 'succeeded'` so a
      // post-success redelivery is a no-op rather than a silent
      // regression of the KPI numerator.
      set: {
        status: input.status,
        failureCode: input.failureCode,
        failureMessage: input.failureMessage,
        outcomeReason: input.outcomeReason,
        amountCents: input.amountCents,
        currency: input.currency,
        updatedAt: new Date(),
      },
      setWhere: sql`${paymentAttempts.status} != 'succeeded'`,
      // No `eq(paymentAttempts.orgId, …)` filter is expressible on
      // ON CONFLICT, but `stripe_payment_intent_id` is platform-wide
      // unique — collisions can only happen for the same tenant.
    });
}

/**
 * Stripe `payment_intent.payment_failed` handler (#436).
 *
 * Records a `payment_attempts` row with `status='failed'`, capturing
 * the bank-side decline code, message, and Radar-level outcome reason
 * if present. Does NOT touch the `donations` table — a failed intent
 * never produces a donation row.
 *
 * Idempotent: upsert on `stripe_payment_intent_id` swallows
 * redeliveries.
 */
async function handlePaymentIntentFailed(
  accountId: string | null,
  intent: Stripe.PaymentIntent,
  log: ReturnType<typeof jobLogger>,
): Promise<void> {
  if (!accountId) {
    log.warn("payment_intent.payment_failed without account_id, skipping");
    return;
  }
  const tenant = await findTenantByStripeAccount(accountId);
  if (!tenant) {
    throw new Error(`No tenant found for Stripe account ${accountId}`);
  }
  const orgId = tenant.id;
  const currency = (intent.currency ?? "eur").toUpperCase();
  const amountCents = intent.amount ?? 0;
  const lastErr = intent.last_payment_error ?? null;
  // Stripe v22 stores the most recent charge under `latest_charge`
  // (either a string id or an expanded Charge); the bank-side `outcome`
  // lives on the Charge. Falls back to null when the intent never
  // reached the charge step (immediate bank rejection).
  const latestCharge = intent.latest_charge;
  const outcomeReason =
    typeof latestCharge === "object" && latestCharge !== null
      ? (latestCharge.outcome?.reason ?? null)
      : null;

  await withWorkerContext(orgId, async (tx) => {
    await upsertPaymentAttempt(tx, orgId, {
      intentId: intent.id,
      amountCents,
      currency,
      status: "failed",
      failureCode: lastErr?.code ?? null,
      failureMessage: lastErr?.message ?? null,
      outcomeReason,
    });
  });

  log.info(
    { paymentIntentId: intent.id, failureCode: lastErr?.code ?? null, outcomeReason },
    "Recorded failed payment attempt from Stripe payment_intent.payment_failed",
  );
}

// ─── #436 — Stripe BalanceTransaction fee enrichment ──────────────────────

/**
 * Lazy-initialised Stripe SDK singleton. Built once on first BT fetch so
 * the worker boot path doesn't crash when `STRIPE_SECRET_KEY` is unset
 * (tests, dev without the dashboard flag flipped on).
 */
let _stripeClient: Stripe | null = null;
function getStripeClient(): Stripe | null {
  if (_stripeClient) return _stripeClient;
  if (!env.STRIPE_SECRET_KEY) return null;
  // Match the API service's pinned API version so the BT payload shape
  // is consistent across the platform. See
  // `packages/api/src/modules/payments/service.ts` § STRIPE_API_VERSION.
  _stripeClient = new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: "2026-04-22.dahlia",
  });
  return _stripeClient;
}

interface FetchStripeFeeArgs {
  intent: Stripe.PaymentIntent;
  stripeAccountId: string;
  targetCurrency: string;
  log: ReturnType<typeof jobLogger>;
}

/**
 * Test seam: production reads the Stripe SDK; tests inject a stub via
 * `setStripeFeeFetcher`. Returning `null` means "no fee enrichment for
 * this intent" — never an error.
 */
export type StripeFeeFetcher = (args: FetchStripeFeeArgs) => Promise<number | null>;

let _stripeFeeFetcher: StripeFeeFetcher | null = null;
export function setStripeFeeFetcher(fetcher: StripeFeeFetcher | null): void {
  _stripeFeeFetcher = fetcher;
}

/**
 * Fetch the Stripe processing fee for a succeeded intent and return it
 * converted into the org's base currency (cents). The BalanceTransaction
 * carries its own `exchange_rate` from charge currency → settlement
 * currency; the math below is:
 *
 *   feeCents (BT currency)
 *     × exchange_rate         (BT → settlement, when set)
 *     × (1 if settlement == base, else look up via ExchangeRateService)
 *
 * For the MVP we trust the BT's own `exchange_rate` only when the BT's
 * settlement currency matches the org base currency. When they diverge
 * (multi-currency Stripe setups), we fall back to NULL — better than
 * stamping an unverified number into the KPI. A follow-up issue (#437
 * surface area) tracks the second-hop FX conversion.
 *
 * Returns `null` when:
 *  - The Stripe SDK isn't configured (`STRIPE_SECRET_KEY` unset)
 *  - The intent carries no `charges.data[0].balance_transaction`
 *  - The BT settlement currency doesn't match the org base currency
 *  - Any Stripe API error — the caller has already wrapped this in
 *    try/catch but we additionally swallow expected "no balance txn
 *    yet" cases.
 */
async function fetchStripeFeeBaseCents(args: FetchStripeFeeArgs): Promise<number | null> {
  if (_stripeFeeFetcher) {
    return _stripeFeeFetcher(args);
  }
  const stripe = getStripeClient();
  if (!stripe) {
    args.log.warn("STRIPE_SECRET_KEY not configured; skipping BT enrichment");
    return null;
  }

  // Stripe v22: `latest_charge` is the canonical pointer (string id or
  // expanded Charge). The Charge's `balance_transaction` is what carries
  // the fee + settlement-currency conversion.
  const latestCharge = args.intent.latest_charge;
  let btId: string | null = null;
  if (typeof latestCharge === "object" && latestCharge !== null) {
    const btRef = latestCharge.balance_transaction;
    btId = typeof btRef === "string" ? btRef : (btRef?.id ?? null);
  } else if (typeof latestCharge === "string") {
    // We have only the charge id — one extra retrieve hop on the
    // connected account to get the BT pointer.
    const charge = await stripe.charges.retrieve(latestCharge, undefined, {
      stripeAccount: args.stripeAccountId,
    });
    const btRef = charge.balance_transaction;
    btId = typeof btRef === "string" ? btRef : (btRef?.id ?? null);
  }
  if (!btId) {
    return null;
  }

  const bt = await stripe.balanceTransactions.retrieve(btId, undefined, {
    stripeAccount: args.stripeAccountId,
  });

  const settlementCurrency = bt.currency.toUpperCase();
  const targetCurrency = args.targetCurrency.toUpperCase();

  if (settlementCurrency !== targetCurrency) {
    // Multi-currency settlement: skip enrichment until #437 wires the
    // second-hop FX conversion (BT.currency → org.baseCurrency).
    // Structured `warn` (not `info`) so the silent-skip is observable
    // on the dashboard — multi-currency tenants will otherwise have a
    // permanently-NULL `stripe_fee_cents` column without operator-side
    // signal.
    args.log.warn(
      {
        bt_id: btId,
        stripe_account: args.stripeAccountId,
        payment_intent_id: args.intent.id,
        settlement_currency: settlementCurrency,
        target_currency: targetCurrency,
        reason: "multi_currency_settlement",
      },
      "stripe BT settlement currency differs from base currency; skipping enrichment",
    );
    return null;
  }

  // BT.fee is in BT.currency cents (already integer).
  // Same currency → no second-hop conversion needed.
  return bt.fee;
}

/**
 * Feature-flag-gated, best-effort enrichment of `donations.stripe_fee_cents`.
 * Extracted out of `handlePaymentIntentSucceeded` so that function stays
 * under the cognitive-complexity threshold. Errors are logged + swallowed —
 * enrichment must never roll back the donation write.
 */
async function maybeEnrichStripeFee(
  tx: Parameters<Parameters<typeof withWorkerContext>[1]>[0],
  args: {
    orgId: string;
    donationId: string;
    intent: Stripe.PaymentIntent;
    stripeAccountId: string;
    targetCurrency: string;
    paymentIntentId: string;
    log: ReturnType<typeof jobLogger>;
  },
): Promise<void> {
  if (!(await isFlagEnabled(FEATURE_FLAG_KEYS.ADMIN_FINANCE_DASHBOARD))) {
    return;
  }
  try {
    const fee = await fetchStripeFeeBaseCents({
      intent: args.intent,
      stripeAccountId: args.stripeAccountId,
      targetCurrency: args.targetCurrency,
      log: args.log,
    });
    if (fee !== null) {
      await tx
        .update(donations)
        .set({ stripeFeeCents: fee })
        .where(and(eq(donations.id, args.donationId), eq(donations.orgId, args.orgId)));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    args.log.warn(
      { err: message, paymentIntentId: args.paymentIntentId },
      "stripe BT enrichment failed; skipping",
    );
  }
}
