import { clearExchangeRateApiCache } from "@givernance/shared";
import {
  constituents,
  donations,
  exchangeRates,
  outboxEvents,
  webhookEvents,
} from "@givernance/shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../lib/db.js";
import { processStripeWebhook } from "../../processors/stripe-webhook.js";

const ORG_ID = "00000000-0000-0000-0000-00000000000b";
const MULTI_CURRENCY_ORG = "00000000-0000-0000-0000-000000000126";
const ORG_ID_OTHER = "00000000-0000-0000-0000-00000000000c";
const STRIPE_ACCOUNT_ID = "acct_test_worker";
const STRIPE_ACCOUNT_ID_MULTI = "acct_test_multi";
const STRIPE_ACCOUNT_ID_OTHER = "acct_test_other";
const TODAY = new Date().toISOString().slice(0, 10);

function makeMockJob(data: Record<string, unknown>) {
  return {
    data,
    id: "test-stripe-job-1",
    log: vi.fn(),
  } as never;
}

beforeAll(async () => {
  // Ensure test tenants with stripe_account_id
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug, stripe_account_id)
        VALUES (${ORG_ID}, 'Stripe Worker Test Org', 'stripe-worker-test', ${STRIPE_ACCOUNT_ID})
        ON CONFLICT (id) DO UPDATE SET stripe_account_id = ${STRIPE_ACCOUNT_ID}`,
  );
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug, stripe_account_id)
        VALUES (${ORG_ID_OTHER}, 'Other Org', 'stripe-worker-other', ${STRIPE_ACCOUNT_ID_OTHER})
        ON CONFLICT (id) DO UPDATE SET stripe_account_id = ${STRIPE_ACCOUNT_ID_OTHER}`,
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

beforeEach(() => {
  clearExchangeRateApiCache();
});

afterAll(async () => {
  // Cleanup in reverse dependency order
  await db.execute(sql`DELETE FROM outbox_events WHERE tenant_id IN (${ORG_ID}, ${ORG_ID_OTHER})`);
  await db.execute(sql`DELETE FROM donations WHERE org_id IN (${ORG_ID}, ${ORG_ID_OTHER})`);
  await db.execute(sql`DELETE FROM constituents WHERE org_id IN (${ORG_ID}, ${ORG_ID_OTHER})`);
  await db.execute(sql`DELETE FROM webhook_events WHERE stripe_event_id LIKE 'evt_test_%'`);
  await db.execute(
    sql`DELETE FROM exchange_rates WHERE currency = 'EUR' AND base_currency = 'CHF' AND date = ${TODAY}`,
  );
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
  });

  it("cross-tenant guard: webhook for Tenant A does not write to Tenant B", async () => {
    // Insert webhook event targeting Tenant A's Stripe account
    await db.insert(webhookEvents).values({
      id: "00000000-0000-0000-0000-0000000000e3",
      stripeEventId: "evt_test_cross_tenant",
      eventType: "payment_intent.succeeded",
      accountId: STRIPE_ACCOUNT_ID,
      payload: {},
      status: "pending",
      livemode: false,
    });

    const job = makeMockJob({
      webhookEventId: "00000000-0000-0000-0000-0000000000e3",
      stripeEventId: "evt_test_cross_tenant",
      eventType: "payment_intent.succeeded",
      accountId: STRIPE_ACCOUNT_ID,
      payload: {
        id: "pi_test_cross_tenant",
        amount: 3000,
        currency: "eur",
        metadata: { constituent_email: "cross-tenant@example.org" },
      },
    });

    await processStripeWebhook(job);

    // Donation should exist for ORG_ID (Tenant A)
    const [donationA] = await db
      .select()
      .from(donations)
      .where(and(eq(donations.orgId, ORG_ID), eq(donations.paymentRef, "pi_test_cross_tenant")));
    expect(donationA).toBeTruthy();

    // Donation must NOT exist for ORG_ID_OTHER (Tenant B)
    const [donationB] = await db
      .select()
      .from(donations)
      .where(
        and(eq(donations.orgId, ORG_ID_OTHER), eq(donations.paymentRef, "pi_test_cross_tenant")),
      );
    expect(donationB).toBeUndefined();
  });

  it("idempotency: duplicate payment_ref does not create a second donation", async () => {
    // Insert webhook event for retry test
    await db.insert(webhookEvents).values({
      id: "00000000-0000-0000-0000-0000000000e4",
      stripeEventId: "evt_test_retry_dup",
      eventType: "payment_intent.succeeded",
      accountId: STRIPE_ACCOUNT_ID,
      payload: {},
      status: "pending",
      livemode: false,
    });

    const jobData = {
      webhookEventId: "00000000-0000-0000-0000-0000000000e4",
      stripeEventId: "evt_test_retry_dup",
      eventType: "payment_intent.succeeded",
      accountId: STRIPE_ACCOUNT_ID,
      payload: {
        id: "pi_test_worker_123", // Same payment_ref as the first test
        amount: 2500,
        currency: "eur",
        metadata: {
          constituent_email: "stripe-donor@example.org",
        },
      },
    };

    await processStripeWebhook(makeMockJob(jobData));

    // Should still only have one donation with that payment_ref
    const dupes = await db
      .select()
      .from(donations)
      .where(and(eq(donations.orgId, ORG_ID), eq(donations.paymentRef, "pi_test_worker_123")));
    expect(dupes).toHaveLength(1);
  });

  it("computes amountBaseCents and exchangeRate from the organization base currency", async () => {
    await db.execute(
      sql`INSERT INTO tenants (id, name, slug, stripe_account_id, base_currency) 
          VALUES (${MULTI_CURRENCY_ORG}, 'Multi Currency', 'multi-currency-worker', ${STRIPE_ACCOUNT_ID_MULTI}, 'JPY')
          ON CONFLICT (id) DO UPDATE SET base_currency = 'JPY', stripe_account_id = EXCLUDED.stripe_account_id`,
    );
    await db
      .insert(exchangeRates)
      .values({
        currency: "USD",
        baseCurrency: "JPY",
        rate: "150.00000000",
        date: TODAY,
      })
      .onConflictDoUpdate({
        target: [exchangeRates.currency, exchangeRates.baseCurrency, exchangeRates.date],
        set: { rate: "150.00000000", updatedAt: new Date() },
      });
    await db.insert(webhookEvents).values({
      id: "00000000-0000-0000-0000-0000000000e5",
      stripeEventId: "evt_test_foreign_currency",
      eventType: "payment_intent.succeeded",
      accountId: STRIPE_ACCOUNT_ID_MULTI,
      payload: {},
      status: "pending",
      livemode: false,
    });

    const job = makeMockJob({
      webhookEventId: "00000000-0000-0000-0000-0000000000e5",
      stripeEventId: "evt_test_foreign_currency",
      eventType: "payment_intent.succeeded",
      accountId: STRIPE_ACCOUNT_ID_MULTI,
      payload: {
        id: "pi_test_foreign_currency",
        amount: 2500,
        currency: "usd",
        metadata: {
          constituent_email: "stripe-fx@example.org",
        },
      },
    });

    await processStripeWebhook(job);

    const [donation] = await db
      .select()
      .from(donations)
      .where(
        and(
          eq(donations.orgId, MULTI_CURRENCY_ORG),
          eq(donations.paymentRef, "pi_test_foreign_currency"),
        ),
      );

    expect(donation?.exchangeRate).toBe("150.00000000");
    expect(donation?.amountBaseCents).toBe(375000);
  });
});
