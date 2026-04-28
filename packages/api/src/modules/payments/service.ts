/** Payments service — Stripe Connect onboarding and webhook event persistence */

import { tenants, webhookEvents } from "@givernance/shared/schema";
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { env } from "../../env.js";
import { db } from "../../lib/db.js";

/** Lazily initialized Stripe client — null when STRIPE_SECRET_KEY is not configured */
let stripeClient: Stripe | null = null;

export function getStripe(): Stripe {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is not configured");
  }
  if (!stripeClient) {
    stripeClient = new Stripe(env.STRIPE_SECRET_KEY);
  }
  return stripeClient;
}

/**
 * Capabilities Givernance requests on every connected account. Without
 * `card_payments`, `paymentIntents.create` errors with "You cannot create
 * a charge on a connected account without the `card_payments` capability
 * enabled." `transfers` is requested alongside so the account can receive
 * funds via destination charges if we ever switch off the direct-charge
 * model. SEPA Direct Debit (`sepa_debit_payments`) is intentionally
 * out-of-scope for Phase 1 — see ADR-010 §11.
 *
 * Both keys are idempotent on Stripe's side: re-requesting an already-
 * requested capability is a no-op, so the same shape covers both
 * `accounts.create` (new accounts) and `accounts.update` (recovering
 * accounts created before this fix landed — issue #192 follow-up).
 */
const REQUESTED_CAPABILITIES = {
  card_payments: { requested: true },
  transfers: { requested: true },
} as const;

/**
 * Create a Stripe Connect Account Link for onboarding.
 * Creates an Express connected account if the tenant doesn't have one yet,
 * otherwise re-asserts the requested capabilities on the existing account
 * so accounts created before the capability fix can be repaired by
 * clicking "Re-open Stripe onboarding".
 */
export async function startStripeOnboarding(
  orgId: string,
  refreshUrl: string,
  returnUrl: string,
): Promise<{ url: string; accountId: string }> {
  const stripe = getStripe();

  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, orgId));
  if (!tenant) {
    throw new Error(`Tenant ${orgId} not found`);
  }

  let accountId = tenant.stripeAccountId;

  if (!accountId) {
    const account = await stripe.accounts.create(
      {
        type: "express",
        capabilities: REQUESTED_CAPABILITIES,
        metadata: { givernance_org_id: orgId },
      },
      { idempotencyKey: `acct-create-${orgId}` },
    );
    accountId = account.id;

    await db
      .update(tenants)
      .set({ stripeAccountId: accountId, updatedAt: new Date() })
      .where(eq(tenants.id, orgId));
  } else {
    // Idempotent — Stripe ignores already-requested capabilities. This is
    // the recovery path for accounts created before capabilities were
    // requested at creation time.
    await stripe.accounts.update(accountId, { capabilities: REQUESTED_CAPABILITIES });
  }

  const accountLink = await stripe.accountLinks.create(
    {
      account: accountId,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: "account_onboarding",
    },
    { idempotencyKey: `acct-link-${orgId}-${Date.now()}` },
  );

  return { url: accountLink.url, accountId };
}

/**
 * Persist a webhook event with status 'pending' for async processing.
 * Stores only event.data.object (not the full Stripe envelope) to avoid
 * persisting unnecessary PII. Uses ON CONFLICT to handle race conditions.
 * Returns the created record, or null if a duplicate was detected.
 */
export async function createWebhookEvent(event: Stripe.Event) {
  const [record] = await db
    .insert(webhookEvents)
    .values({
      stripeEventId: event.id,
      eventType: event.type,
      accountId: event.account ?? null,
      payload: event.data.object as unknown as Record<string, unknown>,
      status: "pending",
      livemode: event.livemode,
    })
    .onConflictDoNothing({ target: webhookEvents.stripeEventId })
    .returning();

  return record ?? null;
}

/**
 * Construct a Stripe event from raw body and signature header.
 * Throws if verification fails.
 */
export function verifyStripeWebhook(rawBody: Buffer, signature: string): Stripe.Event {
  const stripe = getStripe();

  if (!env.STRIPE_WEBHOOK_SECRET) {
    throw new Error("STRIPE_WEBHOOK_SECRET is not configured");
  }

  return stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
}

/** Look up the tenant (org) associated with a Stripe connected account ID */
export async function findTenantByStripeAccount(stripeAccountId: string) {
  const [tenant] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.stripeAccountId, stripeAccountId));

  return tenant ?? null;
}

export interface StripeConnectStatus {
  accountId: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}

/**
 * Read the current Stripe Connect status for a tenant. Returns a "not connected"
 * shape when the tenant has no `stripe_account_id` yet, so the settings UI can
 * render a single panel without a separate 404 path.
 *
 * When the account exists, we hit `accounts.retrieve` so the booleans reflect
 * Stripe's truth — the local DB only stores the account id, not its capabilities.
 * Issue #62 will replace the live retrieve with cached state populated by the
 * `account.updated` webhook, but the retrieve-on-read shape stays the same.
 */
export async function getStripeConnectStatus(orgId: string): Promise<StripeConnectStatus> {
  const [tenant] = await db
    .select({ stripeAccountId: tenants.stripeAccountId })
    .from(tenants)
    .where(eq(tenants.id, orgId));

  if (!tenant?.stripeAccountId) {
    return {
      accountId: null,
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
    };
  }

  const stripe = getStripe();
  const account = await stripe.accounts.retrieve(tenant.stripeAccountId);

  return {
    accountId: tenant.stripeAccountId,
    chargesEnabled: account.charges_enabled,
    payoutsEnabled: account.payouts_enabled,
    detailsSubmitted: account.details_submitted,
  };
}
