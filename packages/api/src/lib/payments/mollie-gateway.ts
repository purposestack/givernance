/**
 * Mollie gateway implementation (issue #62).
 *
 * Mollie's onboarding model differs from Stripe Connect: each NPO signs up
 * with Mollie directly and pastes their API key (`test_…` / `live_…`) into
 * Settings → Payments. The gateway uses that per-tenant key to create
 * payments and fetch them back on webhook receipt. There is no
 * equivalent of Stripe's "connected account id" — a single API key
 * authenticates an entire organisation's Mollie account.
 *
 * Webhook signature verification is platform-side: Mollie signs every
 * request with the platform's `MOLLIE_WEBHOOK_SECRET` (configured in
 * the Mollie dashboard once per Givernance deployment), HMAC-SHA256
 * of the raw body, hex-encoded, in the `X-Mollie-Signature` header
 * (optionally prefixed `sha256=`). See
 * https://github.com/mollie/mollie-api-typescript SignatureValidator
 * for the canonical algorithm — we re-implement here against
 * Node's `crypto` to avoid pulling the TS-only SDK package
 * (which doesn't ship in `@mollie/api-client@4.x`).
 *
 * Idempotency note: Mollie's webhook contract sends only the payment id
 * and current status — the same payment can fire multiple webhooks as
 * its status transitions (`open` → `pending` → `paid` / `failed`). The
 * worker fetches the payment via the API to learn the status, then
 * inserts a `webhook_events` row keyed on `(provider, "${id}-${status}")`
 * so each transition is processed exactly once but a true retry of the
 * same transition is deduped.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import createMollieClient, { type MollieClient } from "@mollie/api-client";
import { env } from "../../env.js";
import type {
  CreateDonationIntentParams,
  CreateDonationIntentResult,
  PaymentGateway,
  TenantPaymentContext,
  VerifiedWebhookEvent,
} from "./gateway.interface.js";

const SIGNATURE_PREFIX = "sha256=";

export class MollieGateway implements PaymentGateway {
  readonly kind = "mollie" as const;

  private clientCache: MollieClient | null = null;

  constructor(private readonly tenant: TenantPaymentContext) {}

  private getClient(): MollieClient {
    if (!this.tenant.mollieApiKey) {
      throw new Error(
        "Organization has not configured Mollie — set tenants.mollie_api_key in Settings",
      );
    }
    if (!this.clientCache) {
      this.clientCache = createMollieClient({ apiKey: this.tenant.mollieApiKey });
    }
    return this.clientCache;
  }

  async createDonationIntent(
    params: CreateDonationIntentParams,
  ): Promise<CreateDonationIntentResult> {
    const client = this.getClient();

    // Mollie expects the amount as a string with two decimals (e.g. "12.50"),
    // not minor units. Currency must be uppercase ISO 4217.
    const amountValue = (params.amountCents / 100).toFixed(2);

    // Mollie's API doesn't have a request-level idempotency header, so we
    // fold the donor's idempotency key into the payment description for
    // after-the-fact reconciliation. A repeat submit from the same browser
    // creates a fresh Mollie payment — it's the donor's call to abandon
    // the orphan, similar to how Stripe handles intent abandonment after
    // 7 days. Filing donor-side dedupe as a follow-up to keep #62 scoped.
    const description = `Donation to campaign ${params.campaignId}`;

    const payment = await client.payments.create({
      amount: { value: amountValue, currency: params.currency.toUpperCase() },
      description,
      redirectUrl: params.returnUrl,
      webhookUrl: params.webhookUrl,
      metadata: {
        campaign_id: params.campaignId,
        org_id: this.tenant.orgId,
        constituent_first_name: params.donor.firstName,
        constituent_last_name: params.donor.lastName,
        constituent_email: params.donor.email,
        application_fee_cents: params.applicationFeeAmountCents,
        ...(params.idempotencyKey ? { idempotency_key: params.idempotencyKey } : {}),
      },
    });

    const checkoutUrl = payment._links?.checkout?.href;
    if (!checkoutUrl) {
      throw new Error("Mollie returned a payment without a checkout URL");
    }

    return {
      provider: "mollie",
      checkoutUrl,
      molliePaymentId: payment.id,
    };
  }

  /**
   * Verify the `X-Mollie-Signature` HMAC over the raw form-encoded body.
   *
   * Mollie's webhook body is `application/x-www-form-urlencoded` with
   * a single `id=tr_…` field — we decode it here so the route handler
   * can keep the request handling minimal. The signature is computed
   * over the raw body exactly as received (Mollie's TS SDK stringifies
   * the buffer with `payload.toString()`; we mirror that with `utf8`).
   */
  async verifyWebhook(rawBody: Buffer, signature: string): Promise<VerifiedWebhookEvent> {
    if (!env.MOLLIE_WEBHOOK_SECRET) {
      throw new Error("MOLLIE_WEBHOOK_SECRET is not configured");
    }

    const provided = signature.startsWith(SIGNATURE_PREFIX)
      ? signature.slice(SIGNATURE_PREFIX.length)
      : signature;

    const expected = createHmac("sha256", env.MOLLIE_WEBHOOK_SECRET).update(rawBody).digest("hex");

    // `timingSafeEqual` requires equal-length buffers — pad-or-fail by
    // comparing buffer lengths first so a malformed (e.g. base64) signature
    // doesn't throw a length-mismatch on us.
    const providedBuf = Buffer.from(provided, "hex");
    const expectedBuf = Buffer.from(expected, "hex");
    if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
      throw new Error("Invalid Mollie webhook signature");
    }

    const params = new URLSearchParams(rawBody.toString("utf8"));
    const paymentId = params.get("id");
    if (!paymentId) {
      throw new Error("Mollie webhook missing 'id' field");
    }

    return {
      // Status is unknown until the worker fetches the payment from Mollie;
      // the worker re-keys the `webhook_events` row with `${id}-${status}`
      // before insert. At route time we use just the payment id — this
      // accepts a duplicate webhook within the same status transition only
      // if the worker hasn't begun processing it yet, which is fine since
      // the worker re-keys on its side and the unique index will reject.
      providerEventId: paymentId,
      eventType: "payment.notification",
      accountId: null,
      livemode: paymentId.startsWith("tr_"),
      payload: { id: paymentId },
    };
  }

  /**
   * Worker-side helper to fetch the full payment. Exposed on the gateway
   * so the worker can construct a Mollie client without re-implementing
   * the per-tenant key lookup. Returns the raw SDK Payment shape — the
   * worker maps it to a domain donation row.
   */
  async getPayment(paymentId: string) {
    const client = this.getClient();
    return client.payments.get(paymentId);
  }
}
