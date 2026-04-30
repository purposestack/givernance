/**
 * Mollie webhook worker integration tests (issue #62).
 *
 * Mocks `@mollie/api-client` so we can drive `processMollieWebhook` against
 * synthetic Mollie Payment shapes without a real Mollie API call. Covers:
 *   - happy path: paid → donation row + outbox event + cleared status
 *   - duplicate paid (BullMQ retry / Mollie retry): no second donation
 *   - non-paid status (failed / authorized / pending): no donation inserted
 *   - cross-tenant probing: 404 from one tenant's key, 200 from another
 *   - webhook_events row re-keyed with `${id}-${status}` for second-stage idempotency
 */

import { clearExchangeRateApiCache } from "@givernance/shared";
import { donations, outboxEvents, webhookEvents } from "@givernance/shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../lib/db.js";

// `@mollie/api-client` is mocked at the module boundary so the worker
// receives the synthetic Payment shapes we build per test. Hoisted
// `mockPaymentsGet` / `mockCreateMollieClient` so `vi.mock`'s factory
// (which is hoisted above all imports by Vitest) can close over them.
const { mockPaymentsGet, mockCreateMollieClient } = vi.hoisted(() => {
  const mockGet = vi.fn();
  const mockClient = vi.fn().mockImplementation(() => ({
    payments: { get: mockGet },
  }));
  return { mockPaymentsGet: mockGet, mockCreateMollieClient: mockClient };
});

vi.mock("@mollie/api-client", () => ({
  default: mockCreateMollieClient,
  PaymentStatus: {
    open: "open",
    canceled: "canceled",
    pending: "pending",
    authorized: "authorized",
    expired: "expired",
    failed: "failed",
    paid: "paid",
  },
}));

// processMollieWebhook is imported AFTER vi.mock so it uses the mocked SDK.
const { processMollieWebhook } = await import("../../processors/mollie-webhook.js");

const ORG_ID = "00000000-0000-0000-0000-00000000010a";
const ORG_ID_OTHER = "00000000-0000-0000-0000-00000000010b";
const MOLLIE_KEY = "test_mollie_primary";
const MOLLIE_KEY_OTHER = "test_mollie_other";

function makeMockJob(data: Record<string, unknown>) {
  return {
    data,
    id: "test-mollie-job-1",
    log: vi.fn(),
  } as never;
}

function makePaidPayment(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "tr_test_paid_1",
    status: "paid",
    method: "ideal",
    amount: { value: "25.00", currency: "EUR" },
    metadata: {
      org_id: ORG_ID,
      campaign_id: null,
      constituent_first_name: "Mollie",
      constituent_last_name: "Donor",
      constituent_email: "mollie-donor@example.org",
    },
    ...overrides,
  };
}

beforeAll(async () => {
  // Seed two Mollie tenants so the cross-tenant probe has somewhere to fail.
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug, payment_gateway, mollie_api_key, base_currency)
        VALUES (${ORG_ID}, 'Mollie Worker Test', 'mollie-worker-test', 'mollie', ${MOLLIE_KEY}, 'EUR')
        ON CONFLICT (id) DO UPDATE
        SET payment_gateway = 'mollie',
            mollie_api_key = ${MOLLIE_KEY},
            base_currency = 'EUR'`,
  );
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug, payment_gateway, mollie_api_key, base_currency)
        VALUES (${ORG_ID_OTHER}, 'Mollie Worker Other', 'mollie-worker-other', 'mollie', ${MOLLIE_KEY_OTHER}, 'EUR')
        ON CONFLICT (id) DO UPDATE
        SET payment_gateway = 'mollie',
            mollie_api_key = ${MOLLIE_KEY_OTHER},
            base_currency = 'EUR'`,
  );
});

beforeEach(() => {
  clearExchangeRateApiCache();
  mockPaymentsGet.mockReset();
  mockCreateMollieClient.mockClear();
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM outbox_events WHERE tenant_id IN (${ORG_ID}, ${ORG_ID_OTHER})`);
  await db.execute(sql`DELETE FROM donations WHERE org_id IN (${ORG_ID}, ${ORG_ID_OTHER})`);
  await db.execute(sql`DELETE FROM constituents WHERE org_id IN (${ORG_ID}, ${ORG_ID_OTHER})`);
  await db.execute(sql`DELETE FROM webhook_events WHERE provider_event_id LIKE 'tr_test_%'`);
  // Reset to stripe so other test files don't see stray Mollie tenants.
  await db.execute(
    sql`UPDATE tenants SET payment_gateway = 'stripe', mollie_api_key = NULL
        WHERE id IN (${ORG_ID}, ${ORG_ID_OTHER})`,
  );
});

describe("processMollieWebhook", () => {
  it("creates a donation + outbox event when status=paid", async () => {
    const paymentId = "tr_test_paid_create";
    await db.insert(webhookEvents).values({
      id: "00000000-0000-0000-0000-0000000000f1",
      provider: "mollie",
      providerEventId: paymentId,
      eventType: "payment.notification",
      accountId: null,
      payload: { id: paymentId },
      status: "pending",
      livemode: false,
    });
    mockPaymentsGet.mockResolvedValueOnce(makePaidPayment({ id: paymentId }));

    const job = makeMockJob({
      webhookEventId: "00000000-0000-0000-0000-0000000000f1",
      providerEventId: paymentId,
      molliePaymentId: paymentId,
      eventType: "payment.notification",
      payload: { id: paymentId },
    });

    await processMollieWebhook(job);

    const [donation] = await db
      .select()
      .from(donations)
      .where(and(eq(donations.orgId, ORG_ID), eq(donations.paymentRef, paymentId)));

    expect(donation).toBeTruthy();
    expect(donation?.amountCents).toBe(2500);
    expect(donation?.currency).toBe("EUR");
    // Granular payment method preserved (the user-cared-about iDEAL distinction).
    expect(donation?.paymentMethod).toBe("ideal");
    // Phase 1: NO platform fee on Mollie path.
    expect(donation?.platformFeeCents).toBe(0);
    expect(donation?.status).toBe("cleared");

    const [event] = await db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.tenantId, ORG_ID)));
    expect(event?.type).toBe("donation.created");

    const [whEvt] = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.id, "00000000-0000-0000-0000-0000000000f1"));
    expect(whEvt?.status).toBe("completed");
    // Re-keyed: `${id}-${status}` so the next status transition has its
    // own row without colliding on the unique index.
    expect(whEvt?.providerEventId).toBe(`${paymentId}-paid`);
  });

  it("skips donation insert for non-paid statuses (authorized, failed, pending)", async () => {
    for (const status of ["authorized", "failed", "pending"] as const) {
      const paymentId = `tr_test_status_${status}`;
      await db.insert(webhookEvents).values({
        id: `00000000-0000-0000-0000-0000000000${status === "authorized" ? "f2" : status === "failed" ? "f3" : "f4"}`,
        provider: "mollie",
        providerEventId: paymentId,
        eventType: "payment.notification",
        accountId: null,
        payload: { id: paymentId },
        status: "pending",
        livemode: false,
      });
      mockPaymentsGet.mockResolvedValueOnce(makePaidPayment({ id: paymentId, status }));

      const job = makeMockJob({
        webhookEventId: `00000000-0000-0000-0000-0000000000${status === "authorized" ? "f2" : status === "failed" ? "f3" : "f4"}`,
        providerEventId: paymentId,
        molliePaymentId: paymentId,
        eventType: "payment.notification",
        payload: { id: paymentId },
      });

      await processMollieWebhook(job);

      // No donation row for this paymentRef
      const [donation] = await db
        .select()
        .from(donations)
        .where(eq(donations.paymentRef, paymentId));
      expect(donation).toBeUndefined();
    }
  });

  it("idempotent against a duplicate paid webhook (donation insert no-ops)", async () => {
    const paymentId = "tr_test_paid_dup";
    await db.insert(webhookEvents).values({
      id: "00000000-0000-0000-0000-0000000000f5",
      provider: "mollie",
      providerEventId: paymentId,
      eventType: "payment.notification",
      accountId: null,
      payload: { id: paymentId },
      status: "pending",
      livemode: false,
    });
    mockPaymentsGet.mockResolvedValue(makePaidPayment({ id: paymentId }));

    await processMollieWebhook(
      makeMockJob({
        webhookEventId: "00000000-0000-0000-0000-0000000000f5",
        providerEventId: paymentId,
        molliePaymentId: paymentId,
        eventType: "payment.notification",
        payload: { id: paymentId },
      }),
    );

    // Insert a SECOND webhook_events row for the duplicate (the route would
    // have inserted only one, but the worker doesn't enforce that — the
    // inner donation `onConflictDoNothing` is the second-stage guard).
    await db.insert(webhookEvents).values({
      id: "00000000-0000-0000-0000-0000000000f6",
      provider: "mollie",
      providerEventId: `${paymentId}-retry`,
      eventType: "payment.notification",
      accountId: null,
      payload: { id: paymentId },
      status: "pending",
      livemode: false,
    });

    await processMollieWebhook(
      makeMockJob({
        webhookEventId: "00000000-0000-0000-0000-0000000000f6",
        providerEventId: `${paymentId}-retry`,
        molliePaymentId: paymentId,
        eventType: "payment.notification",
        payload: { id: paymentId },
      }),
    );

    // EXACTLY one donation row for the (org, payment_method, payment_ref) tuple
    const rows = await db
      .select({ id: donations.id })
      .from(donations)
      .where(and(eq(donations.orgId, ORG_ID), eq(donations.paymentRef, paymentId)));
    expect(rows.length).toBe(1);
  });

  it("cross-tenant probe: 404 from first tenant's key falls through to the next", async () => {
    const paymentId = "tr_test_xprobe";
    await db.insert(webhookEvents).values({
      id: "00000000-0000-0000-0000-0000000000f7",
      provider: "mollie",
      providerEventId: paymentId,
      eventType: "payment.notification",
      accountId: null,
      payload: { id: paymentId },
      status: "pending",
      livemode: false,
    });
    // First call (probably ORG_ID_OTHER) returns 404 → second call returns
    // a paid payment owned by ORG_ID. Order isn't strictly guaranteed (depends
    // on DB row ordering) so we set up both arms via mock implementation.
    mockPaymentsGet.mockImplementationOnce(async () => {
      const err = new Error("Not Found");
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    });
    mockPaymentsGet.mockResolvedValueOnce(
      makePaidPayment({ id: paymentId, metadata: { org_id: ORG_ID } }),
    );

    await processMollieWebhook(
      makeMockJob({
        webhookEventId: "00000000-0000-0000-0000-0000000000f7",
        providerEventId: paymentId,
        molliePaymentId: paymentId,
        eventType: "payment.notification",
        payload: { id: paymentId },
      }),
    );

    // The probe must have called payments.get exactly twice — once for the
    // 404 candidate, once for the matching tenant.
    expect(mockPaymentsGet).toHaveBeenCalledTimes(2);
    expect(mockCreateMollieClient).toHaveBeenCalledTimes(2);
  });
});
