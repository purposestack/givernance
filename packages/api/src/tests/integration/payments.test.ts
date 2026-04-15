import { webhookEvents } from "@givernance/shared/schema";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type Stripe from "stripe";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../lib/db.js";
import { createServer } from "../../server.js";
import { authHeader, ensureTestTenants, signToken, signTokenB } from "../helpers/auth.js";

// vi.hoisted runs before vi.mock hoisting — ensures mocks are defined before use
const { mockQueueAdd, mockVerifyStripeWebhook, mockStartStripeOnboarding } = vi.hoisted(() => ({
  mockQueueAdd: vi.fn().mockResolvedValue({ id: "mock-job-id" }),
  mockVerifyStripeWebhook: vi.fn(),
  mockStartStripeOnboarding: vi.fn(),
}));

// Mock BullMQ Queue to avoid needing a real Redis queue connection for route tests
vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: mockQueueAdd,
  })),
}));

// Mock only Stripe signature verification — we can't call real Stripe APIs.
// Real DB functions (createWebhookEvent) are kept so we test actual persistence.
vi.mock("../../modules/payments/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../modules/payments/service.js")>();
  return {
    ...actual,
    verifyStripeWebhook: (...args: unknown[]) => mockVerifyStripeWebhook(...args),
    startStripeOnboarding: (...args: unknown[]) => mockStartStripeOnboarding(...args),
  };
});

let app: FastifyInstance;

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM webhook_events WHERE stripe_event_id LIKE 'evt_test_%'`);
  await app.close();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Stripe Connect Onboarding ─────────────────────────────────────────────

describe("POST /v1/admin/stripe-connect", () => {
  it("returns 401 without auth", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/stripe-connect",
      payload: {
        refreshUrl: "http://localhost:3000/settings/stripe?refresh=true",
        returnUrl: "http://localhost:3000/settings/stripe?success=true",
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 for non-admin user", async () => {
    const token = signToken(app, { role: "viewer" });
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/stripe-connect",
      headers: authHeader(token),
      payload: {
        refreshUrl: "http://localhost:3000/settings/stripe?refresh=true",
        returnUrl: "http://localhost:3000/settings/stripe?success=true",
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("creates a Stripe Connect account link for org_admin", async () => {
    mockStartStripeOnboarding.mockResolvedValueOnce({
      url: "https://connect.stripe.com/setup/s/test",
      accountId: "acct_test_123",
    });

    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/stripe-connect",
      headers: authHeader(token),
      payload: {
        refreshUrl: "http://localhost:3000/settings/stripe?refresh=true",
        returnUrl: "http://localhost:3000/settings/stripe?success=true",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { url: string; accountId: string } }>();
    expect(body.data.url).toContain("stripe.com");
    expect(body.data.accountId).toBe("acct_test_123");
    expect(mockStartStripeOnboarding).toHaveBeenCalledOnce();
  });

  it("returns 502 with masked error when Stripe fails", async () => {
    mockStartStripeOnboarding.mockRejectedValueOnce(new Error("Stripe API rate limit exceeded"));

    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/stripe-connect",
      headers: authHeader(token),
      payload: {
        refreshUrl: "http://localhost:3000/settings/stripe?refresh=true",
        returnUrl: "http://localhost:3000/settings/stripe?success=true",
      },
    });

    expect(res.statusCode).toBe(502);
    const body = res.json<{ detail: string }>();
    // Stripe error message must NOT leak to caller
    expect(body.detail).not.toContain("rate limit");
    expect(body.detail).toContain("Payment provider error");
  });

  it("returns 403 when Tenant B tries to onboard (cross-tenant guard)", async () => {
    const token = signTokenB(app, { role: "viewer" });
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/stripe-connect",
      headers: authHeader(token),
      payload: {
        refreshUrl: "http://localhost:3000/settings/stripe?refresh=true",
        returnUrl: "http://localhost:3000/settings/stripe?success=true",
      },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ─── Stripe Webhook ────────────────────────────────────────────────────────

describe("POST /v1/donations/stripe-webhook", () => {
  it("returns 400 without stripe-signature header", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/donations/stripe-webhook",
      payload: Buffer.from("{}"),
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty("detail", "Missing stripe-signature");
  });

  it("returns 400 for invalid signature with masked error", async () => {
    mockVerifyStripeWebhook.mockImplementationOnce(() => {
      throw new Error("No signatures found matching the expected signature for payload");
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/donations/stripe-webhook",
      payload: Buffer.from("{}"),
      headers: {
        "content-type": "application/json",
        "stripe-signature": "invalid",
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ detail: string }>();
    // Must not echo the raw Stripe error
    expect(body.detail).toBe("Signature verification failed");
  });

  it("accepts and enqueues a valid webhook event (persisted to DB)", async () => {
    const eventId = `evt_test_${Date.now()}`;
    mockVerifyStripeWebhook.mockReturnValueOnce({
      id: eventId,
      type: "payment_intent.succeeded",
      livemode: false,
      account: "acct_test_123",
      data: {
        object: { id: "pi_test_123", amount: 5000, currency: "eur", metadata: {} },
      },
    } as unknown as Stripe.Event);

    const res = await app.inject({
      method: "POST",
      url: "/v1/donations/stripe-webhook",
      payload: Buffer.from(JSON.stringify({ type: "payment_intent.succeeded" })),
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=123,v1=abc",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });

    // Verify the event was persisted to the real DB
    const [persisted] = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.stripeEventId, eventId));
    expect(persisted).toBeTruthy();
    expect(persisted?.eventType).toBe("payment_intent.succeeded");
    expect(persisted?.status).toBe("pending");
    // Payload should be event.data.object, NOT the full envelope
    const payloadObj = persisted?.payload as Record<string, unknown>;
    expect(payloadObj).toHaveProperty("id", "pi_test_123");
    expect(payloadObj).not.toHaveProperty("type"); // no envelope fields

    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-stripe-webhook",
      expect.objectContaining({ stripeEventId: eventId }),
      expect.any(Object),
    );
  });

  it("returns 200 for duplicate event (idempotency via ON CONFLICT)", async () => {
    const eventId = `evt_test_idempotent_${Date.now()}`;

    // First call — insert succeeds
    mockVerifyStripeWebhook.mockReturnValue({
      id: eventId,
      type: "payment_intent.succeeded",
      livemode: false,
      account: "acct_test_123",
      data: {
        object: { id: "pi_dup_test", amount: 1000, currency: "eur", metadata: {} },
      },
    } as unknown as Stripe.Event);

    const res1 = await app.inject({
      method: "POST",
      url: "/v1/donations/stripe-webhook",
      payload: Buffer.from("{}"),
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=123,v1=abc",
      },
    });
    expect(res1.statusCode).toBe(200);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);

    // Second call with same event ID — ON CONFLICT should detect duplicate
    const res2 = await app.inject({
      method: "POST",
      url: "/v1/donations/stripe-webhook",
      payload: Buffer.from("{}"),
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=123,v1=abc",
      },
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.json()).toEqual({ received: true });
    // Queue should NOT be called again for the duplicate
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
  });
});
