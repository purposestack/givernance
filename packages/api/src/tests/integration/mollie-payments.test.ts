/**
 * Mollie webhook + payment-gateway settings tests (issue #62).
 *
 * Mirrors `payments.test.ts` but for the Mollie surface: HMAC signature
 * verification, idempotent persistence, and the org-admin
 * GET/PATCH `/admin/payment-gateway` route. The Mollie API client is
 * NOT mocked at the SDK level — only the route layer is exercised here,
 * so no live Mollie traffic.
 */

import { createHmac } from "node:crypto";
import { tenants, webhookEvents } from "@givernance/shared/schema";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../lib/db.js";
import { createServer } from "../../server.js";
import {
  authHeader,
  ensureTestTenants,
  ORG_A,
  ORG_B,
  signToken,
  signTokenB,
} from "../helpers/auth.js";

const { mockQueueAdd } = vi.hoisted(() => ({
  mockQueueAdd: vi.fn().mockResolvedValue({ id: "mock-job-id" }),
}));

vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: mockQueueAdd,
  })),
}));

// Must match the value set in `src/tests/setup.ts` so the route's env-loaded
// secret matches the bytes we sign with in this file.
const TEST_MOLLIE_WEBHOOK_SECRET = "test-mollie-secret";

let app: FastifyInstance;

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM webhook_events WHERE provider_event_id LIKE 'tr_test_%'`);
  // Reset gateway selection on the test tenants so other test files start
  // from a known state.
  await db
    .update(tenants)
    .set({ paymentGateway: "stripe", mollieApiKey: null, featureFlags: {} })
    .where(eq(tenants.id, ORG_A));
  await app.close();
});

afterEach(() => {
  vi.clearAllMocks();
});

function signMollieBody(body: string): string {
  return createHmac("sha256", TEST_MOLLIE_WEBHOOK_SECRET).update(body).digest("hex");
}

// ─── Mollie webhook ────────────────────────────────────────────────────────

describe("POST /v1/donations/mollie-webhook", () => {
  it("returns 400 without x-mollie-signature header", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/donations/mollie-webhook",
      payload: "id=tr_test_unauth",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty("detail", "Missing x-mollie-signature");
  });

  it("returns 400 for invalid signature", async () => {
    const body = "id=tr_test_invalidsig";
    const res = await app.inject({
      method: "POST",
      url: "/v1/donations/mollie-webhook",
      payload: body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-mollie-signature": "deadbeef",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty("detail", "Signature verification failed");
  });

  it("accepts a valid signature, persists the event, and enqueues a Mollie job", async () => {
    const paymentId = `tr_test_${Date.now()}`;
    const body = `id=${paymentId}`;
    const signature = signMollieBody(body);

    const res = await app.inject({
      method: "POST",
      url: "/v1/donations/mollie-webhook",
      payload: body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-mollie-signature": signature,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });

    const [persisted] = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.providerEventId, paymentId));
    expect(persisted).toBeTruthy();
    expect(persisted?.provider).toBe("mollie");
    expect(persisted?.eventType).toBe("payment.notification");

    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-mollie-webhook",
      expect.objectContaining({ molliePaymentId: paymentId }),
      expect.any(Object),
    );
  });

  it("accepts the sha256= prefix on the signature header", async () => {
    const paymentId = `tr_test_prefix_${Date.now()}`;
    const body = `id=${paymentId}`;
    const signature = `sha256=${signMollieBody(body)}`;

    const res = await app.inject({
      method: "POST",
      url: "/v1/donations/mollie-webhook",
      payload: body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-mollie-signature": signature,
      },
    });

    expect(res.statusCode).toBe(200);
  });

  it("returns 200 for a duplicate event (idempotency)", async () => {
    const paymentId = `tr_test_dup_${Date.now()}`;
    const body = `id=${paymentId}`;
    const signature = signMollieBody(body);

    const res1 = await app.inject({
      method: "POST",
      url: "/v1/donations/mollie-webhook",
      payload: body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-mollie-signature": signature,
      },
    });
    expect(res1.statusCode).toBe(200);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);

    const res2 = await app.inject({
      method: "POST",
      url: "/v1/donations/mollie-webhook",
      payload: body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-mollie-signature": signature,
      },
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.json()).toEqual({ received: true });
    // Duplicate must NOT enqueue a second job
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
  });
});

// ─── Org-admin gateway settings ────────────────────────────────────────────

describe("GET /v1/admin/payment-gateway", () => {
  it("returns 401 without auth", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/admin/payment-gateway" });
    expect(res.statusCode).toBe(401);
  });

  it.each([
    { role: "viewer" as const },
    { role: "user" as const },
  ])("returns 403 for role $role", async ({ role }) => {
    const token = signToken(app, { role });
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/payment-gateway",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(403);
    const body = res.json<{ type: string; status: number }>();
    expect(body.type).toBe("https://httpproblems.com/http-status/403");
    expect(body.status).toBe(403);
  });

  it("returns the current gateway state", async () => {
    await db
      .update(tenants)
      .set({ paymentGateway: "stripe", mollieApiKey: null, featureFlags: {} })
      .where(eq(tenants.id, ORG_A));

    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/payment-gateway",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        paymentGateway: string;
        mollieConfigured: boolean;
        flags: { "ff.payments.mollie": boolean };
      };
    }>();
    expect(body.data.paymentGateway).toBe("stripe");
    expect(body.data.mollieConfigured).toBe(false);
    expect(body.data.flags["ff.payments.mollie"]).toBe(false);
  });
});

describe("PATCH /v1/admin/payment-gateway", () => {
  it("rejects switching to mollie when ff.payments.mollie is off (400)", async () => {
    await db
      .update(tenants)
      .set({ paymentGateway: "stripe", mollieApiKey: null, featureFlags: {} })
      .where(eq(tenants.id, ORG_A));

    const token = signToken(app);
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/admin/payment-gateway",
      headers: authHeader(token),
      payload: { paymentGateway: "mollie", mollieApiKey: "test_xxx" },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ detail: string }>();
    expect(body.detail).toContain("Mollie is not enabled");
  });

  it("rejects switching to mollie without an api key (400) even when the flag is on", async () => {
    await db
      .update(tenants)
      .set({
        paymentGateway: "stripe",
        mollieApiKey: null,
        featureFlags: { "ff.payments.mollie": true },
      })
      .where(eq(tenants.id, ORG_A));

    const token = signToken(app);
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/admin/payment-gateway",
      headers: authHeader(token),
      payload: { paymentGateway: "mollie" },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ detail: string }>();
    expect(body.detail).toContain("Mollie API key is required");
  });

  it("activates Mollie when the flag is on AND an api key is provided", async () => {
    // Explicitly reset BOTH tenants to a known clean state — the test file
    // is shared across re-runs against the same `givernance_test` DB, and
    // a prior run's "isolates" test could have left ORG_B at `manual`.
    await db
      .update(tenants)
      .set({
        paymentGateway: "stripe",
        mollieApiKey: null,
        featureFlags: { "ff.payments.mollie": true },
      })
      .where(eq(tenants.id, ORG_A));
    await db
      .update(tenants)
      .set({ paymentGateway: "stripe", mollieApiKey: null, featureFlags: {} })
      .where(eq(tenants.id, ORG_B));

    const token = signToken(app);
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/admin/payment-gateway",
      headers: authHeader(token),
      payload: { paymentGateway: "mollie", mollieApiKey: "test_xxx_yyy" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: { paymentGateway: string; mollieConfigured: boolean };
    }>();
    expect(body.data.paymentGateway).toBe("mollie");
    expect(body.data.mollieConfigured).toBe(true);

    // Cross-tenant isolation: ORG_B must NOT have been touched.
    const [orgB] = await db
      .select({ paymentGateway: tenants.paymentGateway, mollieApiKey: tenants.mollieApiKey })
      .from(tenants)
      .where(eq(tenants.id, ORG_B));
    expect(orgB?.paymentGateway).toBe("stripe");
    expect(orgB?.mollieApiKey).toBeNull();
  });

  it("isolates the PATCH to the calling org (cross-tenant)", async () => {
    // Tenant B switches its own gateway — must not affect Tenant A.
    await db
      .update(tenants)
      .set({
        paymentGateway: "stripe",
        mollieApiKey: null,
        featureFlags: { "ff.payments.mollie": true },
      })
      .where(eq(tenants.id, ORG_B));
    await db
      .update(tenants)
      .set({ paymentGateway: "stripe", mollieApiKey: "preserved" })
      .where(eq(tenants.id, ORG_A));

    const tokenB = signTokenB(app);
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/admin/payment-gateway",
      headers: authHeader(tokenB),
      payload: { paymentGateway: "manual" },
    });
    expect(res.statusCode).toBe(200);

    const [orgA] = await db
      .select({ paymentGateway: tenants.paymentGateway, mollieApiKey: tenants.mollieApiKey })
      .from(tenants)
      .where(eq(tenants.id, ORG_A));
    expect(orgA?.paymentGateway).toBe("stripe");
    expect(orgA?.mollieApiKey).toBe("preserved");
  });
});
