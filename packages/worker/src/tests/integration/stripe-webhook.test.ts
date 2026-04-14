import { constituents, donations, outboxEvents, webhookEvents } from "@givernance/shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../lib/db.js";
import { processStripeWebhook } from "../../processors/stripe-webhook.js";

const ORG_ID = "00000000-0000-0000-0000-00000000000b";
const STRIPE_ACCOUNT_ID = "acct_test_worker";

function makeMockJob(data: Record<string, unknown>) {
  return {
    data,
    id: "test-stripe-job-1",
    log: vi.fn(),
  } as never;
}

beforeAll(async () => {
  // Ensure test tenant with stripe_account_id
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug, stripe_account_id)
        VALUES (${ORG_ID}, 'Stripe Worker Test Org', 'stripe-worker-test', ${STRIPE_ACCOUNT_ID})
        ON CONFLICT (id) DO UPDATE SET stripe_account_id = ${STRIPE_ACCOUNT_ID}`,
  );

  // Insert a webhook_events row for the processor to update
  await db.insert(webhookEvents).values({
    id: "00000000-0000-0000-0000-0000000000e1",
    stripeEventId: "evt_test_pi_succeeded",
    eventType: "payment_intent.succeeded",
    accountId: STRIPE_ACCOUNT_ID,
    payload: {},
    status: "pending",
    livemode: false,
  });
});

afterAll(async () => {
  // Cleanup in reverse dependency order
  await db.execute(sql`DELETE FROM outbox_events WHERE tenant_id = ${ORG_ID}`);
  await db.execute(sql`DELETE FROM donations WHERE org_id = ${ORG_ID}`);
  await db.execute(sql`DELETE FROM constituents WHERE org_id = ${ORG_ID}`);
  await db.execute(sql`DELETE FROM webhook_events WHERE stripe_event_id = 'evt_test_pi_succeeded'`);
});

describe("processStripeWebhook", () => {
  it("creates a donation and constituent from payment_intent.succeeded", async () => {
    const job = makeMockJob({
      webhookEventId: "00000000-0000-0000-0000-0000000000e1",
      stripeEventId: "evt_test_pi_succeeded",
      eventType: "payment_intent.succeeded",
      accountId: STRIPE_ACCOUNT_ID,
      payload: {
        id: "pi_test_worker_123",
        amount: 2500,
        currency: "eur",
        metadata: {
          constituent_email: "stripe-donor@example.org",
          constituent_first_name: "Stripe",
          constituent_last_name: "Donor",
        },
      },
    });

    await processStripeWebhook(job);

    // Verify donation was created
    const [donation] = await db
      .select()
      .from(donations)
      .where(and(eq(donations.orgId, ORG_ID), eq(donations.paymentRef, "pi_test_worker_123")));

    expect(donation).toBeTruthy();
    expect(donation?.amountCents).toBe(2500);
    expect(donation?.currency).toBe("EUR");
    expect(donation?.paymentMethod).toBe("stripe");

    // Verify constituent was created
    const [constituent] = await db
      .select()
      .from(constituents)
      .where(
        and(eq(constituents.orgId, ORG_ID), eq(constituents.email, "stripe-donor@example.org")),
      );

    expect(constituent).toBeTruthy();
    expect(constituent?.firstName).toBe("Stripe");
    expect(constituent?.lastName).toBe("Donor");

    // Verify outbox event was emitted
    const [event] = await db.select().from(outboxEvents).where(eq(outboxEvents.tenantId, ORG_ID));

    expect(event).toBeTruthy();
    expect(event?.type).toBe("donation.created");

    // Verify webhook event status was updated
    const [webhookEvt] = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.stripeEventId, "evt_test_pi_succeeded"));

    expect(webhookEvt?.status).toBe("completed");
    expect(webhookEvt?.processedAt).toBeTruthy();
  });

  it("throws when no tenant matches the Stripe account", async () => {
    // Insert webhook event for the unknown account test
    await db.insert(webhookEvents).values({
      id: "00000000-0000-0000-0000-0000000000e2",
      stripeEventId: "evt_test_unknown_account",
      eventType: "payment_intent.succeeded",
      accountId: "acct_nonexistent",
      payload: {},
      status: "pending",
      livemode: false,
    });

    const job = makeMockJob({
      webhookEventId: "00000000-0000-0000-0000-0000000000e2",
      stripeEventId: "evt_test_unknown_account",
      eventType: "payment_intent.succeeded",
      accountId: "acct_nonexistent",
      payload: {
        id: "pi_test_unknown",
        amount: 1000,
        currency: "eur",
        metadata: {},
      },
    });

    await expect(processStripeWebhook(job)).rejects.toThrow("No tenant found");

    // Cleanup
    await db.execute(
      sql`DELETE FROM webhook_events WHERE stripe_event_id = 'evt_test_unknown_account'`,
    );
  });
});
