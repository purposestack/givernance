/** Job processor — handle Mollie webhook events asynchronously (issue #62) */

import { ExchangeRateService } from "@givernance/shared";
import type { ProcessMollieWebhookJob } from "@givernance/shared/jobs";
import {
  campaigns,
  constituents,
  donations,
  outboxEvents,
  tenants,
  webhookEvents,
} from "@givernance/shared/schema";
import createMollieClient, { type Payment, PaymentStatus } from "@mollie/api-client";
import type { Job } from "bullmq";
import { and, eq, sql } from "drizzle-orm";
import { env } from "../env.js";
import { db, withWorkerContext } from "../lib/db.js";
import { jobLogger } from "../lib/logger.js";

/**
 * Process a Mollie webhook event.
 *
 * Mollie's webhook contract is "the resource changed, go fetch it" —
 * we re-fetch the payment via the per-tenant API key on every webhook
 * receipt to avoid trusting client-side state. The status drives the
 * downstream action:
 *
 *   - `paid`              → upsert donation row, emit DonationCreated
 *   - `failed` / `canceled` / `expired` → log; donation row stays absent
 *   - `pending` / `open` / `authorized` → log; nothing else (the next
 *      transition will fire another webhook).
 *
 * The unique index on `webhook_events(provider, provider_event_id)` is
 * keyed on the Mollie payment id at route time. The worker re-keys on
 * `${id}-${status}` for the second-stage idempotency: if a webhook
 * fires twice for the same status (Mollie retry), we already inserted
 * the donation and the donation-side `(org_id, payment_method,
 * payment_ref)` unique index also catches it.
 */
export async function processMollieWebhook(
  job: Job<ProcessMollieWebhookJob["data"]>,
): Promise<void> {
  const { webhookEventId, providerEventId, molliePaymentId } = job.data;
  const log = jobLogger({ jobId: job.id, traceId: providerEventId });

  log.info({ molliePaymentId }, "Processing Mollie webhook event");

  await db
    .update(webhookEvents)
    .set({ status: "processing" })
    .where(eq(webhookEvents.id, webhookEventId));

  try {
    const resolved = await resolveMolliePayment(molliePaymentId);
    if (!resolved) {
      log.warn({ molliePaymentId }, "No Mollie tenant claimed this payment — skipping");
      await markWebhookCompleted(webhookEventId);
      return;
    }

    await rekeyWebhookEvent(
      webhookEventId,
      providerEventId,
      molliePaymentId,
      resolved.payment,
      log,
    );

    if (
      resolved.payment.status === PaymentStatus.paid ||
      resolved.payment.status === PaymentStatus.authorized
    ) {
      await handleMolliePaid(resolved.orgId, resolved.payment, log);
    } else {
      log.info(
        { molliePaymentId, status: resolved.payment.status },
        "Mollie payment not paid — no donation row inserted",
      );
    }

    await markWebhookCompleted(webhookEventId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    log.error({ err: message, molliePaymentId }, "Failed to process Mollie webhook event");

    await db
      .update(webhookEvents)
      .set({ status: "failed", error: message })
      .where(eq(webhookEvents.id, webhookEventId));

    throw err;
  }
}

async function markWebhookCompleted(webhookEventId: string): Promise<void> {
  await db
    .update(webhookEvents)
    .set({ status: "completed", processedAt: new Date() })
    .where(eq(webhookEvents.id, webhookEventId));
}

/**
 * Resolve the tenant that owns a Mollie payment id by fetching it with each
 * Mollie-enabled tenant's API key in turn. 404 = wrong tenant, try the next;
 * other errors propagate so BullMQ retries.
 *
 * With small numbers of Mollie-enabled tenants per Phase 1 deployment this
 * is acceptable; a Mollie Connect / OAuth flow would let us tag a `profileId`
 * on the webhook and skip the probing entirely (filed as ADR-010 future work).
 */
async function resolveMolliePayment(
  molliePaymentId: string,
): Promise<{ payment: Payment; orgId: string } | null> {
  const mollieTenants = await db
    .select({ id: tenants.id, mollieApiKey: tenants.mollieApiKey })
    .from(tenants)
    .where(eq(tenants.paymentGateway, "mollie"));

  const candidates = mollieTenants.filter((t): t is { id: string; mollieApiKey: string } =>
    Boolean(t.mollieApiKey),
  );

  for (const t of candidates) {
    const fetched = await fetchPaymentWithKey(t.mollieApiKey, molliePaymentId);
    if (fetched) {
      return { payment: fetched, orgId: t.id };
    }
  }
  return null;
}

async function fetchPaymentWithKey(apiKey: string, paymentId: string): Promise<Payment | null> {
  try {
    const client = createMollieClient({ apiKey });
    return await client.payments.get(paymentId);
  } catch (err) {
    const status =
      err && typeof err === "object" && "statusCode" in err
        ? (err as { statusCode?: number }).statusCode
        : undefined;
    if (status === 404) return null;
    throw err;
  }
}

/**
 * Re-key the webhook_events row with `${id}-${status}` so subsequent status
 * transitions for the same payment don't collide on the unique index. A
 * collision (Mollie retry on the same status) silently no-ops; the donation
 * insert below is also idempotent on (org_id, payment_method, payment_ref).
 */
async function rekeyWebhookEvent(
  webhookEventId: string,
  currentEventId: string,
  molliePaymentId: string,
  payment: Payment,
  log: ReturnType<typeof jobLogger>,
): Promise<void> {
  const statusEventId = `${molliePaymentId}-${payment.status}`;
  if (statusEventId === currentEventId) return;

  await db
    .update(webhookEvents)
    .set({ providerEventId: statusEventId })
    .where(eq(webhookEvents.id, webhookEventId))
    .catch((err) => {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Failed to rekey Mollie webhook_event id (likely a duplicate transition); continuing",
      );
    });
}

interface MollieDonationMeta {
  constituentEmail?: string;
  constituentFirstName: string;
  constituentLastName: string;
  campaignId: string | null;
  platformFeeCents: number;
}

function extractMollieDonationMeta(payment: Payment): MollieDonationMeta {
  const meta = (payment.metadata as Record<string, unknown> | null) ?? {};
  return {
    constituentEmail:
      typeof meta.constituent_email === "string" ? meta.constituent_email : undefined,
    constituentFirstName:
      typeof meta.constituent_first_name === "string" ? meta.constituent_first_name : "Anonymous",
    constituentLastName:
      typeof meta.constituent_last_name === "string" ? meta.constituent_last_name : "Donor",
    campaignId: typeof meta.campaign_id === "string" ? meta.campaign_id : null,
    platformFeeCents:
      typeof meta.application_fee_cents === "number" ? meta.application_fee_cents : 0,
  };
}

/**
 * Find-or-create the constituent for a Mollie donation. Mirrors the Stripe
 * flow's behaviour: prefer email-keyed lookup, fall back to a fresh anonymous
 * row when no email is available.
 */
async function findOrCreateMollieConstituent(
  tx: Parameters<Parameters<typeof withWorkerContext>[1]>[0],
  orgId: string,
  meta: MollieDonationMeta,
  log: ReturnType<typeof jobLogger>,
): Promise<string> {
  if (meta.constituentEmail) {
    const [existing] = await tx
      .select({ id: constituents.id })
      .from(constituents)
      .where(
        sql`${constituents.orgId} = ${orgId} AND ${constituents.email} = ${meta.constituentEmail}`,
      );
    if (existing) return existing.id;

    const [created] = await tx
      .insert(constituents)
      .values({
        orgId,
        firstName: meta.constituentFirstName,
        lastName: meta.constituentLastName,
        email: meta.constituentEmail,
        type: "donor",
      })
      .returning({ id: constituents.id });
    // biome-ignore lint/style/noNonNullAssertion: insert returning always returns
    log.info({ constituentId: created!.id }, "Created new constituent from Mollie");
    // biome-ignore lint/style/noNonNullAssertion: insert returning always returns
    return created!.id;
  }

  const [created] = await tx
    .insert(constituents)
    .values({
      orgId,
      firstName: meta.constituentFirstName,
      lastName: meta.constituentLastName,
      type: "donor",
    })
    .returning({ id: constituents.id });
  // biome-ignore lint/style/noNonNullAssertion: insert returning always returns
  return created!.id;
}

async function handleMolliePaid(
  orgId: string,
  payment: Payment,
  log: ReturnType<typeof jobLogger>,
): Promise<void> {
  const meta = extractMollieDonationMeta(payment);
  const amountCents = Math.round(Number(payment.amount.value) * 100);
  const currency = payment.amount.currency.toUpperCase();
  const paymentRef = payment.id;
  const { campaignId, platformFeeCents } = meta;

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

    const constituentId = await findOrCreateMollieConstituent(tx, orgId, meta, log);

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
        paymentMethod: "mollie",
        paymentRef,
        donatedAt: new Date(),
        fiscalYear: new Date().getFullYear(),
      })
      .onConflictDoNothing()
      .returning();

    if (!donation) {
      log.info({ paymentRef }, "Donation already exists (retry), skipping");
      return;
    }

    if (campaignId && platformFeeCents > 0) {
      // Same defence-in-depth pattern as the Stripe path — explicit org_id
      // filter alongside the RLS context so a tampered `metadata.campaign_id`
      // can't cross tenant boundaries.
      await tx
        .update(campaigns)
        .set({
          platformFeesCents: sql`${campaigns.platformFeesCents} + ${platformFeeCents}`,
          updatedAt: new Date(),
        })
        .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)));
    }

    await tx.insert(outboxEvents).values({
      tenantId: orgId,
      type: "donation.created",
      payload: {
        donationId: donation.id,
        constituentId,
        amountCents,
        currency,
        paymentMethod: "mollie",
        paymentRef,
        source: "mollie_webhook",
      },
    });

    log.info(
      {
        amountBaseCents: convertedAmount.amountBaseCents,
        baseCurrency,
        constituentId,
        currency,
        donationId: donation.id,
        exchangeRate: convertedAmount.exchangeRate,
        amountCents,
        paymentRef,
      },
      "Donation created from Mollie payment.paid",
    );
  });
}
