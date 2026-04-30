/**
 * Payment gateway abstraction (ADR-010 / issue #62).
 *
 * The donor flow, refund flow, and webhook ingestion all dispatch through
 * this interface so the rest of the API never imports Stripe or Mollie SDK
 * types directly. Adding a new gateway (Saferpay, Mangopay) is implementing
 * `PaymentGateway`, registering it in `gateway-factory.ts`, and extending
 * the `PAYMENT_GATEWAY_VALUES` enum — no other module changes.
 *
 * Why an interface and not a discriminated union of services: a discriminated
 * union puts gateway-specific code in every consumer (each route would
 * `switch (gateway.kind)`). An interface lets each consumer call the same
 * methods and the implementation handles the provider-specific shape.
 */

/** Per-tenant context the factory passes through to each gateway. */
export interface TenantPaymentContext {
  /** Org id (UUID) — used as `metadata.org_id` and for log correlation. */
  orgId: string;
  /** `acct_…` (Stripe) — null when the tenant uses Mollie or hasn't onboarded. */
  stripeAccountId: string | null;
  /** Per-tenant Mollie API key — null when the tenant uses Stripe. */
  mollieApiKey: string | null;
}

/** Common params for the donor `POST /v1/public/campaigns/:id/donate` route. */
export interface CreateDonationIntentParams {
  campaignId: string;
  /** ISO 4217 (uppercase) — the donor's chosen currency. */
  currency: string;
  amountCents: number;
  /** `applicationFeeAmount` for Stripe; not currently surfaced for Mollie. */
  applicationFeeAmountCents: number;
  /** Donor identity threaded as gateway-side metadata for the webhook to recover. */
  donor: {
    email: string;
    firstName: string;
    lastName: string;
  };
  /**
   * Idempotency key supplied by the browser (`Idempotency-Key` header). Forwarded
   * to the gateway's own idempotency mechanism — Stripe dedupes server-side via
   * the same key; Mollie doesn't have a request-level idempotency header so the
   * key is folded into the payment description for after-the-fact reconciliation.
   */
  idempotencyKey?: string;
  /** Browser-side return URL after the donor finishes / abandons the gateway flow. */
  returnUrl: string;
  /** Public webhook URL Mollie will POST to once the payment status changes. */
  webhookUrl: string;
}

/**
 * Discriminated union returned to the donor's browser. The frontend renders
 * Stripe Elements when `provider === 'stripe'` and a redirect button when
 * `provider === 'mollie'` — anything else is a programming error caught by
 * the route's TypeBox response schema.
 */
export type CreateDonationIntentResult =
  | {
      provider: "stripe";
      clientSecret: string;
      stripeAccountId: string;
    }
  | {
      provider: "mollie";
      checkoutUrl: string;
      molliePaymentId: string;
    };

/**
 * Webhook signature verification. Implementations throw on invalid signature;
 * the route turns that into a 400 with a sanitised body so the gateway error
 * detail (which can leak internals) never reaches the client.
 *
 * Returns the parsed event in a provider-agnostic envelope. The
 * `providerEventId` field is what feeds `webhook_events.provider_event_id`
 * for idempotency — Mollie doesn't emit unique event ids, so the gateway
 * synthesises `${paymentId}-${status}` to keep one row per status transition.
 */
export interface VerifiedWebhookEvent {
  providerEventId: string;
  eventType: string;
  /** Stripe connected-account id; null for Mollie events. */
  accountId: string | null;
  /** Provider-side livemode flag — Stripe carries it natively, Mollie's payment id prefix indicates it. */
  livemode: boolean;
  payload: Record<string, unknown>;
}

export interface PaymentGateway {
  /** Stable kind discriminator — used in logs and the enqueued job's name. */
  readonly kind: "stripe" | "mollie";
  /**
   * Create a payment intent / Mollie payment. Returns a discriminated union
   * the donor frontend uses to decide which UI to render.
   */
  createDonationIntent(params: CreateDonationIntentParams): Promise<CreateDonationIntentResult>;
  /**
   * Verify a webhook signature and parse the body into a provider-agnostic
   * envelope. Throws on invalid signature; the caller must NOT echo the
   * thrown error message verbatim to the wire.
   */
  verifyWebhook(rawBody: Buffer, signature: string): Promise<VerifiedWebhookEvent>;
}
