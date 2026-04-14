import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type Stripe from "stripe";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../lib/db.js";
import { createServer } from "../../server.js";
import { authHeader, ensureTestTenants, signToken } from "../helpers/auth.js";

// vi.hoisted runs before vi.mock hoisting
const {
  mockStartStripeOnboarding,
  mockVerifyStripeWebhook,
  mockFindWebhookEvent,
  mockCreateWebhookEvent,
  mockQueueAdd,
} = vi.hoisted(() => ({
  mockStartStripeOnboarding: vi.fn(),
  mockVerifyStripeWebhook: vi.fn(),
  mockFindWebhookEvent: vi.fn(),
  mockCreateWebhookEvent: vi.fn(),
  mockQueueAdd: vi.fn().mockResolvedValue({ id: "mock-job-id" }),
}));

// Mock the service module directly
vi.mock("../../modules/payments/service.js", () => ({
  startStripeOnboarding: mockStartStripeOnboarding,
  verifyStripeWebhook: mockVerifyStripeWebhook,
  findWebhookEvent: mockFindWebhookEvent,
  createWebhookEvent: mockCreateWebhookEvent,
  getStripe: vi.fn(),
}));

// Mock BullMQ Queue to avoid needing Redis
vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: mockQueueAdd,
  })),
}));

let app: FastifyInstance;

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM webhook_events WHERE stripe_event_id LIKE 'evt_%'`);
  await app.close();
});

// Clear mock call history between tests to avoid cross-test contamination
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

  it("returns 400 for invalid signature", async () => {
    mockVerifyStripeWebhook.mockImplementationOnce(() => {
      throw new Error("Webhook signature verification failed");
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
  });

  it("accepts and enqueues a valid webhook event", async () => {
    const eventId = `evt_${Date.now()}`;
    mockVerifyStripeWebhook.mockReturnValueOnce({
      id: eventId,
      type: "payment_intent.succeeded",
      livemode: false,
      account: "acct_test_123",
      data: {
        object: { id: "pi_test_123", amount: 5000, currency: "eur", metadata: {} },
      },
    } as unknown as Stripe.Event);

    mockFindWebhookEvent.mockResolvedValueOnce(null);
    mockCreateWebhookEvent.mockResolvedValueOnce({ id: "wh-uuid-1" });

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
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-stripe-webhook",
      expect.objectContaining({ stripeEventId: eventId }),
      expect.any(Object),
    );
  });

  it("returns 200 for duplicate event (idempotency)", async () => {
    const knownEventId = "evt_idempotency_test";

    mockVerifyStripeWebhook.mockReturnValueOnce({
      id: knownEventId,
      type: "payment_intent.succeeded",
      livemode: false,
      data: { object: {} },
    } as unknown as Stripe.Event);

    // findWebhookEvent returns existing record → should skip
    mockFindWebhookEvent.mockResolvedValueOnce({
      id: "existing-uuid",
      stripeEventId: knownEventId,
      status: "completed",
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/donations/stripe-webhook",
      payload: Buffer.from("{}"),
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=123,v1=abc",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    // createWebhookEvent should NOT be called for duplicates
    expect(mockCreateWebhookEvent).not.toHaveBeenCalled();
  });
});
