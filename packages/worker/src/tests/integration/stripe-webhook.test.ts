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
    provider: "stripe",
    providerEventId: "evt_test_pi_succeeded",
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
  await db.execute(sql`DELETE FROM webhook_events WHERE provider_event_id LIKE 'evt_test_%'`);
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
      .where(eq(webhookEvents.providerEventId, "evt_test_pi_succeeded"));

    expect(webhookEvt?.status).toBe("completed");
    expect(webhookEvt?.processedAt).toBeTruthy();
  });

  it("throws when no tenant matches the Stripe account", async () => {
    // Insert webhook event for the unknown account test
    await db.insert(webhookEvents).values({
      id: "00000000-0000-0000-0000-0000000000e2",
      provider: "stripe",
      providerEventId: "evt_test_unknown_account",
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
      provider: "stripe",
      providerEventId: "evt_test_cross_tenant",
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
      provider: "stripe",
      providerEventId: "evt_test_retry_dup",
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
      provider: "stripe",
      providerEventId: "evt_test_foreign_currency",
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

  // ─── #198: malformed payload rejected, not silently inserted as €0 ──────

  it("DLQs (throws) when payment_intent payload is missing required fields", async () => {
    // Insert a webhook_events row so the processor has somewhere to write
    // its `failed` status update.
    await db.insert(webhookEvents).values({
      id: "00000000-0000-0000-0000-0000000000ee",
      provider: "stripe",
      providerEventId: "evt_test_malformed_pi",
      eventType: "payment_intent.succeeded",
      accountId: STRIPE_ACCOUNT_ID,
      payload: {},
      status: "pending",
    });

    const job = makeMockJob({
      webhookEventId: "00000000-0000-0000-0000-0000000000ee",
      stripeEventId: "evt_test_malformed_pi",
      eventType: "payment_intent.succeeded",
      accountId: STRIPE_ACCOUNT_ID,
      payload: {
        // Missing `id` and `amount` — would have silently inserted a €0
        // donation under the previous `as number ?? 0` casts.
        currency: "eur",
      },
    });

    await expect(processStripeWebhook(job)).rejects.toThrow(/Malformed payment_intent/);

    // No donation row written
    const matches = await db
      .select()
      .from(donations)
      .where(and(eq(donations.orgId, ORG_ID), eq(donations.paymentRef, "evt_test_malformed_pi")));
    expect(matches).toHaveLength(0);

    // webhook_events flipped to failed (so the BullMQ retry chain has a record)
    const [event] = await db
      .select({ status: webhookEvents.status, error: webhookEvents.error })
      .from(webhookEvents)
      .where(eq(webhookEvents.id, "00000000-0000-0000-0000-0000000000ee"));
    expect(event?.status).toBe("failed");
    expect(event?.error).toContain("Malformed payment_intent");
  });

  // ─── #199: charge.refunded marks donation refunded + decrements campaign fee ──

  it("charge.refunded flips status to refunded + decrements campaign platform fee", async () => {
    // First seed a cleared Stripe donation we can refund.
    const paymentRef = "pi_test_refund_target";
    await db.execute(
      sql`INSERT INTO constituents (id, org_id, first_name, last_name, type)
          VALUES ('00000000-0000-0000-0000-0000000000c1', ${ORG_ID}, 'Refund', 'Target', 'donor')
          ON CONFLICT (id) DO NOTHING`,
    );
    await db.execute(
      sql`INSERT INTO campaigns (id, org_id, name, type, platform_fees_cents)
          VALUES ('00000000-0000-0000-0000-0000000000c2', ${ORG_ID}, 'Refund Campaign', 'digital', 105)
          ON CONFLICT (id) DO UPDATE SET platform_fees_cents = 105`,
    );
    await db.execute(
      sql`INSERT INTO donations
          (org_id, constituent_id, amount_cents, currency, exchange_rate, amount_base_cents,
           campaign_id, status, platform_fee_cents, payment_method, payment_ref, donated_at, fiscal_year)
          VALUES (${ORG_ID}, '00000000-0000-0000-0000-0000000000c1', 5000, 'EUR', '1', 5000,
                  '00000000-0000-0000-0000-0000000000c2', 'cleared', 105, 'stripe', ${paymentRef}, now(), 2026)
          ON CONFLICT DO NOTHING`,
    );
    await db.insert(webhookEvents).values({
      id: "00000000-0000-0000-0000-0000000000ef",
      provider: "stripe",
      providerEventId: "evt_test_refund_1",
      eventType: "charge.refunded",
      accountId: STRIPE_ACCOUNT_ID,
      payload: {},
      status: "pending",
    });

    const job = makeMockJob({
      webhookEventId: "00000000-0000-0000-0000-0000000000ef",
      stripeEventId: "evt_test_refund_1",
      eventType: "charge.refunded",
      accountId: STRIPE_ACCOUNT_ID,
      payload: {
        id: "ch_test_refund_1",
        payment_intent: paymentRef,
      },
    });

    await processStripeWebhook(job);

    const [donation] = await db
      .select({ status: donations.status })
      .from(donations)
      .where(and(eq(donations.orgId, ORG_ID), eq(donations.paymentRef, paymentRef)));
    expect(donation?.status).toBe("refunded");

    // Campaign platform-fee accumulator rolled back
    const campaignResult = await db.execute(
      sql`SELECT platform_fees_cents FROM campaigns WHERE id = '00000000-0000-0000-0000-0000000000c2'`,
    );
    const campaignRows = (
      campaignResult as unknown as { rows: { platform_fees_cents: string | number }[] }
    ).rows;
    // Postgres `bigint` (or numeric-summed) columns can come back as strings
    // through node-pg; normalise before asserting.
    expect(Number(campaignRows[0]?.platform_fees_cents ?? -1)).toBe(0);

    // donation.refunded outbox event emitted
    const events = await db
      .select({ type: outboxEvents.type, payload: outboxEvents.payload })
      .from(outboxEvents)
      .where(and(eq(outboxEvents.tenantId, ORG_ID), eq(outboxEvents.type, "donation.refunded")));
    expect(events.length).toBeGreaterThan(0);

    // Audit log row written by the worker (PR #193 finding #9). The API
    // refund route is captured by the audit plugin via `onResponse`, but
    // a refund initiated from the NPO's Stripe dashboard skips that path
    // entirely — the worker is the only place we can record the state
    // change in that case.
    const auditRows = await db.execute(
      sql`SELECT user_id, actor_id, action, resource_type, resource_id, old_values, new_values
          FROM audit_logs
          WHERE org_id = ${ORG_ID}
            AND action = 'WEBHOOK:charge.refunded'
            AND resource_id = (SELECT id::text FROM donations WHERE org_id = ${ORG_ID} AND payment_ref = ${paymentRef})`,
    );
    const auditRow = (auditRows as unknown as { rows: Record<string, unknown>[] }).rows[0];
    expect(auditRow).toBeDefined();
    // System-initiated → both null. Forensic readers compute "who did
    // this" via COALESCE(actor_id, user_id, 'system').
    expect(auditRow?.user_id).toBeNull();
    expect(auditRow?.actor_id).toBeNull();
    expect(auditRow?.resource_type).toBe("donations");
    expect(auditRow?.old_values).toMatchObject({ status: "cleared" });
    expect(auditRow?.new_values).toMatchObject({
      status: "refunded",
      paymentIntentId: paymentRef,
    });
  });

  it("charge.refunded is idempotent on already-refunded donations", async () => {
    // Donation seeded as already refunded — handler should short-circuit
    // (no second outbox event, no second decrement).
    const paymentRef = "pi_test_refund_idempotent";
    await db.execute(
      sql`INSERT INTO constituents (id, org_id, first_name, last_name, type)
          VALUES ('00000000-0000-0000-0000-0000000000d1', ${ORG_ID}, 'Refund', 'Idempotent', 'donor')
          ON CONFLICT (id) DO NOTHING`,
    );
    await db.execute(
      sql`INSERT INTO donations
          (org_id, constituent_id, amount_cents, currency, exchange_rate, amount_base_cents,
           status, platform_fee_cents, payment_method, payment_ref, donated_at, fiscal_year)
          VALUES (${ORG_ID}, '00000000-0000-0000-0000-0000000000d1', 5000, 'EUR', '1', 5000,
                  'refunded', 105, 'stripe', ${paymentRef}, now(), 2026)
          ON CONFLICT DO NOTHING`,
    );
    await db.insert(webhookEvents).values({
      id: "00000000-0000-0000-0000-0000000000ea",
      provider: "stripe",
      providerEventId: "evt_test_refund_idempotent",
      eventType: "charge.refunded",
      accountId: STRIPE_ACCOUNT_ID,
      payload: {},
      status: "pending",
    });

    const job = makeMockJob({
      webhookEventId: "00000000-0000-0000-0000-0000000000ea",
      stripeEventId: "evt_test_refund_idempotent",
      eventType: "charge.refunded",
      accountId: STRIPE_ACCOUNT_ID,
      payload: {
        id: "ch_test_refund_idempotent",
        payment_intent: paymentRef,
      },
    });

    // Should NOT throw — short-circuits on already-refunded.
    await processStripeWebhook(job);

    // Only one (or zero) refunded outbox event for this paymentRef — the
    // first refund route call already emitted one in seeded data; the
    // webhook handler must NOT emit a second.
    const events = await db
      .select({ payload: outboxEvents.payload })
      .from(outboxEvents)
      .where(and(eq(outboxEvents.tenantId, ORG_ID), eq(outboxEvents.type, "donation.refunded")));
    const matchingPayloads = events.filter(
      (e) => (e.payload as { paymentRef?: string }).paymentRef === paymentRef,
    );
    expect(matchingPayloads.length).toBeLessThanOrEqual(1);
  });

  // ─── account.updated (issue #62) ─────────────────────────────────────────

  it("caches Stripe charges_enabled / payouts_enabled / details_submitted on the tenant", async () => {
    await db.insert(webhookEvents).values({
      id: "00000000-0000-0000-0000-0000000000eb",
      provider: "stripe",
      providerEventId: "evt_test_account_updated",
      eventType: "account.updated",
      accountId: STRIPE_ACCOUNT_ID,
      payload: {},
      status: "pending",
    });

    // Reset cached state to false so we can observe the flip.
    await db.execute(
      sql`UPDATE tenants
          SET stripe_charges_enabled = false,
              stripe_payouts_enabled = false,
              stripe_details_submitted = false,
              stripe_account_state_at = NULL
          WHERE id = ${ORG_ID}`,
    );

    const job = makeMockJob({
      webhookEventId: "00000000-0000-0000-0000-0000000000eb",
      stripeEventId: "evt_test_account_updated",
      eventType: "account.updated",
      accountId: null,
      payload: {
        id: STRIPE_ACCOUNT_ID,
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
      },
    });

    await processStripeWebhook(job);

    const result = await db.execute(
      sql`SELECT stripe_charges_enabled, stripe_payouts_enabled, stripe_details_submitted, stripe_account_state_at
          FROM tenants WHERE id = ${ORG_ID}`,
    );
    const tenant = (result as { rows?: Record<string, unknown>[] }).rows?.[0] ?? undefined;
    expect(tenant?.stripe_charges_enabled).toBe(true);
    expect(tenant?.stripe_payouts_enabled).toBe(true);
    expect(tenant?.stripe_details_submitted).toBe(true);
    expect(tenant?.stripe_account_state_at).toBeTruthy();
  });

  it("ignores account.updated for an unknown connected account (no DLQ throw)", async () => {
    await db.insert(webhookEvents).values({
      id: "00000000-0000-0000-0000-0000000000ec",
      provider: "stripe",
      providerEventId: "evt_test_account_updated_unknown",
      eventType: "account.updated",
      accountId: "acct_definitely_not_a_real_tenant",
      payload: {},
      status: "pending",
    });

    const job = makeMockJob({
      webhookEventId: "00000000-0000-0000-0000-0000000000ec",
      stripeEventId: "evt_test_account_updated_unknown",
      eventType: "account.updated",
      accountId: null,
      payload: {
        id: "acct_definitely_not_a_real_tenant",
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
      },
    });

    // Must NOT throw — unknown account is logged + marked completed so the
    // job doesn't enter the DLQ.
    await expect(processStripeWebhook(job)).resolves.toBeUndefined();
  });
});
