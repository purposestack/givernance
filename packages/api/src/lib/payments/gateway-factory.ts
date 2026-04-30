/**
 * Payment gateway factory (issue #62).
 *
 * `getGatewayForTenant` is the only call site that should know about the
 * `tenant.payment_gateway` value — the rest of the API holds a
 * `PaymentGateway` reference. The factory enforces the
 * `ff.payments.mollie` feature flag: a tenant whose `payment_gateway` is
 * `'mollie'` but whose flag is off raises a 502-equivalent error so a
 * mis-flipped DB state can't sneak past the gate.
 */

import type { tenants } from "@givernance/shared/schema";
import type { InferSelectModel } from "drizzle-orm";
import { hasFeatureFlag } from "../feature-flags.js";
import type { PaymentGateway, TenantPaymentContext } from "./gateway.interface.js";
import { MollieGateway } from "./mollie-gateway.js";
import { StripeGateway } from "./stripe-gateway.js";

type TenantRow = InferSelectModel<typeof tenants>;

/** Subset of `tenants` row the factory needs — accepts both partial mocks and full rows. */
export type TenantGatewaySelector = Pick<
  TenantRow,
  "id" | "paymentGateway" | "stripeAccountId" | "mollieApiKey" | "featureFlags"
>;

export class PaymentGatewayUnavailableError extends Error {
  readonly reason:
    | "manual_gateway"
    | "mollie_flag_off"
    | "mollie_not_configured"
    | "stripe_not_onboarded";

  constructor(
    reason: "manual_gateway" | "mollie_flag_off" | "mollie_not_configured" | "stripe_not_onboarded",
    message: string,
  ) {
    super(message);
    this.name = "PaymentGatewayUnavailableError";
    this.reason = reason;
  }
}

export function getGatewayForTenant(tenant: TenantGatewaySelector): PaymentGateway {
  const ctx: TenantPaymentContext = {
    orgId: tenant.id,
    stripeAccountId: tenant.stripeAccountId ?? null,
    mollieApiKey: tenant.mollieApiKey ?? null,
  };

  switch (tenant.paymentGateway) {
    case "stripe":
      if (!tenant.stripeAccountId) {
        throw new PaymentGatewayUnavailableError(
          "stripe_not_onboarded",
          "Stripe Connect onboarding is not complete for this tenant",
        );
      }
      return new StripeGateway(ctx);
    case "mollie":
      if (!hasFeatureFlag(tenant, "ff.payments.mollie")) {
        throw new PaymentGatewayUnavailableError(
          "mollie_flag_off",
          "Mollie is not enabled for this tenant",
        );
      }
      if (!tenant.mollieApiKey) {
        throw new PaymentGatewayUnavailableError(
          "mollie_not_configured",
          "Mollie API key is not configured for this tenant",
        );
      }
      return new MollieGateway(ctx);
    case "manual":
      throw new PaymentGatewayUnavailableError(
        "manual_gateway",
        "Tenant uses manual reconciliation — no online donations supported",
      );
    default: {
      // Defence-in-depth — the CHECK constraint on tenants.payment_gateway
      // covers the DB side, this guards against an in-process row that
      // bypassed validation (e.g., a service test seeding directly).
      const exhaustive: never = tenant.paymentGateway as never;
      throw new Error(`Unsupported payment_gateway value: ${String(exhaustive)}`);
    }
  }
}

/**
 * Standalone Mollie gateway instantiation for the platform-side webhook
 * route, which doesn't have a tenant in context yet (the route receives
 * the body, signs the payload with `MOLLIE_WEBHOOK_SECRET`, and resolves
 * the tenant only after the worker has fetched the payment). Pass an
 * orgId of empty string — the gateway only uses the api key for outbound
 * calls, which the route doesn't make.
 */
export function getMollieWebhookVerifier(): MollieGateway {
  return new MollieGateway({
    orgId: "",
    stripeAccountId: null,
    mollieApiKey: null,
  });
}
