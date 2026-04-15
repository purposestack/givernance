import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../lib/db.js";
import { createServer } from "../../server.js";
import { authHeader, ensureTestTenants, ORG_A, signToken } from "../helpers/auth.js";

// vi.hoisted runs before vi.mock hoisting
const { mockGetStripe, mockPaymentIntentsCreate, mockQueueAdd } = vi.hoisted(() => {
  const mockPaymentIntentsCreate = vi.fn().mockResolvedValue({
    id: "pi_test_123",
    client_secret: "pi_test_123_secret_abc",
  });
  return {
    mockGetStripe: vi.fn().mockReturnValue({
      paymentIntents: { create: mockPaymentIntentsCreate },
      accounts: { retrieve: vi.fn().mockResolvedValue({ charges_enabled: true }) },
    }),
    mockPaymentIntentsCreate,
    mockQueueAdd: vi.fn().mockResolvedValue({ id: "mock-job-id" }),
  };
});

vi.mock("../../modules/payments/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../modules/payments/service.js")>();
  return {
    ...actual,
    getStripe: mockGetStripe,
  };
});

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

  // Ensure the test tenant has a Stripe account ID
  await db.execute(
    sql`UPDATE tenants SET stripe_account_id = 'acct_test_org_a' WHERE id = ${ORG_A}`,
  );
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM campaign_public_pages WHERE org_id = ${ORG_A}`);
  await db.execute(
    sql`DELETE FROM campaigns WHERE org_id = ${ORG_A} AND name LIKE 'Public Page Test%'`,
  );
  await app.close();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Helper: create a campaign for tests ──────────────────────────────────

async function createTestCampaign(name: string) {
  const token = signToken(app);
  const res = await app.inject({
    method: "POST",
    url: "/v1/campaigns",
    headers: authHeader(token),
    payload: { name, type: "digital" },
  });
  return res.json<{ data: { id: string } }>().data;
}

// ─── PUT /v1/campaigns/:id/public-page (admin) ──────────────────────────

describe("PUT /v1/campaigns/:id/public-page", () => {
  it("returns 401 without auth", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/v1/campaigns/00000000-0000-0000-0000-000000000001/public-page",
      payload: { title: "Test Page" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("creates a public page config for a campaign", async () => {
    const campaign = await createTestCampaign("Public Page Test Create");
    const token = signToken(app);

    const res = await app.inject({
      method: "PUT",
      url: `/v1/campaigns/${campaign.id}/public-page`,
      headers: authHeader(token),
      payload: {
        title: "Help Us Build Schools",
        description: "Every euro counts",
        colorPrimary: "#FF5733",
        goalAmountCents: 500000,
        status: "published",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { title: string; status: string; campaignId: string } }>();
    expect(body.data.title).toBe("Help Us Build Schools");
    expect(body.data.status).toBe("published");
    expect(body.data.campaignId).toBe(campaign.id);
  });

  it("updates an existing public page config", async () => {
    const campaign = await createTestCampaign("Public Page Test Update");
    const token = signToken(app);

    // Create first
    await app.inject({
      method: "PUT",
      url: `/v1/campaigns/${campaign.id}/public-page`,
      headers: authHeader(token),
      payload: { title: "Original Title", status: "draft" },
    });

    // Update
    const res = await app.inject({
      method: "PUT",
      url: `/v1/campaigns/${campaign.id}/public-page`,
      headers: authHeader(token),
      payload: { title: "Updated Title", status: "published" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { title: string; status: string } }>();
    expect(body.data.title).toBe("Updated Title");
    expect(body.data.status).toBe("published");
  });

  it("returns 404 for non-existent campaign", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "PUT",
      url: "/v1/campaigns/00000000-0000-0000-0000-ffffffffffff/public-page",
      headers: authHeader(token),
      payload: { title: "Test Page" },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ─── GET /v1/public/campaigns/:id/page (unauthenticated) ─────────────────

describe("GET /v1/public/campaigns/:id/page", () => {
  it("returns published page without auth", async () => {
    const campaign = await createTestCampaign("Public Page Test Public GET");
    const token = signToken(app);

    // Create a published page
    await app.inject({
      method: "PUT",
      url: `/v1/campaigns/${campaign.id}/public-page`,
      headers: authHeader(token),
      payload: {
        title: "Public Campaign",
        description: "Donate now",
        colorPrimary: "#00FF00",
        goalAmountCents: 100000,
        status: "published",
      },
    });

    // Fetch without auth
    const res = await app.inject({
      method: "GET",
      url: `/v1/public/campaigns/${campaign.id}/page`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: { title: string; description: string; goalAmountCents: number };
    }>();
    expect(body.data.title).toBe("Public Campaign");
    expect(body.data.description).toBe("Donate now");
    expect(body.data.goalAmountCents).toBe(100000);
  });

  it("returns 404 for draft page (not published)", async () => {
    const campaign = await createTestCampaign("Public Page Test Draft");
    const token = signToken(app);

    // Create a draft page
    await app.inject({
      method: "PUT",
      url: `/v1/campaigns/${campaign.id}/public-page`,
      headers: authHeader(token),
      payload: { title: "Draft Campaign", status: "draft" },
    });

    const res = await app.inject({
      method: "GET",
      url: `/v1/public/campaigns/${campaign.id}/page`,
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for non-existent campaign", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/public/campaigns/00000000-0000-0000-0000-ffffffffffff/page",
    });
    expect(res.statusCode).toBe(404);
  });
});

// ─── POST /v1/public/campaigns/:id/donate (unauthenticated) ──────────────

describe("POST /v1/public/campaigns/:id/donate", () => {
  it("creates a Stripe PaymentIntent for a published campaign", async () => {
    const campaign = await createTestCampaign("Public Page Test Donate");
    const token = signToken(app);

    // Publish the page
    await app.inject({
      method: "PUT",
      url: `/v1/campaigns/${campaign.id}/public-page`,
      headers: authHeader(token),
      payload: { title: "Donate Page", status: "published" },
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/public/campaigns/${campaign.id}/donate`,
      payload: {
        amountCents: 5000,
        currency: "EUR",
        email: "donor@example.org",
        firstName: "Jane",
        lastName: "Doe",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { clientSecret: string } }>();
    expect(body.data.clientSecret).toBe("pi_test_123_secret_abc");

    // Verify Stripe was called with correct params
    expect(mockPaymentIntentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 5000,
        currency: "eur",
        application_fee_amount: 105, // (5000 * 0.015) + 30
        metadata: expect.objectContaining({
          campaign_id: campaign.id,
          constituent_first_name: "Jane",
          constituent_last_name: "Doe",
        }),
      }),
      expect.objectContaining({
        stripeAccount: "acct_test_org_a",
      }),
    );
  });

  it("passes idempotency key to Stripe", async () => {
    const campaign = await createTestCampaign("Public Page Test Idempotency");
    const token = signToken(app);

    await app.inject({
      method: "PUT",
      url: `/v1/campaigns/${campaign.id}/public-page`,
      headers: authHeader(token),
      payload: { title: "Donate Page", status: "published" },
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/public/campaigns/${campaign.id}/donate`,
      headers: { "idempotency-key": "idem-key-123" },
      payload: {
        amountCents: 2500,
        currency: "CHF",
        email: "donor@example.org",
        firstName: "Jean",
        lastName: "Dupont",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(mockPaymentIntentsCreate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        idempotencyKey: "idem-key-123",
      }),
    );
  });

  it("returns 404 when campaign page is not published", async () => {
    const campaign = await createTestCampaign("Public Page Test Unpublished Donate");
    // No public page created → not published

    const res = await app.inject({
      method: "POST",
      url: `/v1/public/campaigns/${campaign.id}/donate`,
      payload: {
        amountCents: 1000,
        currency: "EUR",
        email: "donor@example.org",
        firstName: "Test",
        lastName: "User",
      },
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 400 for invalid body (missing email)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/public/campaigns/00000000-0000-0000-0000-ffffffffffff/donate",
      payload: {
        amountCents: 1000,
        currency: "EUR",
        firstName: "Test",
        lastName: "User",
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for amount below minimum", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/public/campaigns/00000000-0000-0000-0000-ffffffffffff/donate",
      payload: {
        amountCents: 50,
        currency: "EUR",
        email: "donor@example.org",
        firstName: "Test",
        lastName: "User",
      },
    });

    expect(res.statusCode).toBe(400);
  });
});
