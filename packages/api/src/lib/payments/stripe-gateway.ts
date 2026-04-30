/**
 * Stripe gateway implementation (ADR-010).
 *
 * Wraps the singleton `Stripe` client created in `modules/payments/service.ts`
 * — the actual SDK init lives there because a bunch of pre-#62 code paths
 * (refunds, account.retrieve in `getStripeConnectStatus`, account-link
 * onboarding) call `getStripe()` directly. Centralising those callers behind
 * the gateway interface is out of scope for #62; for now this file is the
 * `PaymentGateway`-facing facade and the rest stays where it is.
 */

import { env } from "../../env.js";
import { getStripe } from "../../modules/payments/service.js";
import type {
  CreateDonationIntentParams,
  CreateDonationIntentResult,
  PaymentGateway,
  TenantPaymentContext,
  VerifiedWebhookEvent,
} from "./gateway.interface.js";

export class StripeGateway implements PaymentGateway {
  readonly kind = "stripe" as const;

  constructor(private readonly tenant: TenantPaymentContext) {}

  async createDonationIntent(
    params: CreateDonationIntentParams,
  ): Promise<CreateDonationIntentResult> {
    if (!this.tenant.stripeAccountId) {
      throw new Error("Organization has not completed Stripe onboarding");
    }

    const stripe = getStripe();

    // Live retrieve to short-circuit donations against accounts that aren't
    // chargeable yet — keeps the existing pre-#62 behaviour. Once
    // `tenants.stripe_charges_enabled` is broadly populated by the
    // `account.updated` webhook (also #62), this check can read the cached
    // column and skip the round-trip; until then the live retrieve is the
    // safety belt against a stale cache.
    const account = await stripe.accounts.retrieve(this.tenant.stripeAccountId);
    if (!account.charges_enabled) {
      throw new Error("Organization Stripe account is not fully onboarded");
    }

    const intentParams: Parameters<typeof stripe.paymentIntents.create>[0] = {
      amount: params.amountCents,
      currency: params.currency.toLowerCase(),
      application_fee_amount: params.applicationFeeAmountCents,
      receipt_email: params.donor.email,
      metadata: {
        campaign_id: params.campaignId,
        org_id: this.tenant.orgId,
        // Reconciliation breadcrumb — the campaign's books currency
        // alongside the donor's chosen currency. Survives the round-trip
        // to the `payment_intent.succeeded` webhook for finance reports.
        campaign_default_currency: params.campaignDefaultCurrency,
        constituent_first_name: params.donor.firstName,
        constituent_last_name: params.donor.lastName,
      },
    };

    const requestOptions: Parameters<typeof stripe.paymentIntents.create>[1] = {
      stripeAccount: this.tenant.stripeAccountId,
    };

    if (params.idempotencyKey) {
      requestOptions.idempotencyKey = params.idempotencyKey;
    }

    const intent = await stripe.paymentIntents.create(intentParams, requestOptions);

    if (!intent.client_secret) {
      throw new Error("Stripe returned a PaymentIntent without a client_secret");
    }

    return {
      provider: "stripe",
      clientSecret: intent.client_secret,
      stripeAccountId: this.tenant.stripeAccountId,
      paymentIntentId: intent.id,
    };
  }

  async verifyWebhook(rawBody: Buffer, signature: string): Promise<VerifiedWebhookEvent> {
    if (!env.STRIPE_WEBHOOK_SECRET) {
      throw new Error("STRIPE_WEBHOOK_SECRET is not configured");
    }

    const stripe = getStripe();
    const event = stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);

    return {
      providerEventId: event.id,
      eventType: event.type,
      accountId: event.account ?? null,
      livemode: event.livemode,
      payload: event.data.object as unknown as Record<string, unknown>,
    };
  }
}
