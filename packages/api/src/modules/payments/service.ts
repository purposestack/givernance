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
 * Create a Stripe Connect Account Link for onboarding.
 * Creates an Express connected account if the tenant doesn't have one yet,
 * then returns the onboarding URL.
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
    const account = await stripe.accounts.create({
      type: "express",
      metadata: { givernance_org_id: orgId },
    });
    accountId = account.id;

    await db
      .update(tenants)
      .set({ stripeAccountId: accountId, updatedAt: new Date() })
      .where(eq(tenants.id, orgId));
  }

  const accountLink = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: "account_onboarding",
  });

  return { url: accountLink.url, accountId };
}

/**
 * Check if a Stripe event has already been processed (idempotency).
 * Returns the existing webhook event record if found, null otherwise.
 */
export async function findWebhookEvent(stripeEventId: string) {
  const [existing] = await db
    .select()
    .from(webhookEvents)
    .where(eq(webhookEvents.stripeEventId, stripeEventId));

  return existing ?? null;
}

/**
 * Persist a webhook event with status 'pending' for async processing.
 * Returns the created webhook event record.
 */
export async function createWebhookEvent(event: Stripe.Event) {
  const [record] = await db
    .insert(webhookEvents)
    .values({
      stripeEventId: event.id,
      eventType: event.type,
      accountId: event.account ?? null,
      payload: event as unknown as Record<string, unknown>,
      status: "pending",
      livemode: event.livemode,
    })
    .returning();

  return record;
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
