import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "../../server.js";
import { authHeader, ensureTestTenants, ORG_A, signToken } from "../helpers/auth.js";
import { db } from "../helpers/db.js";

const PRIMARY_THEME_COLOR = "#08675b";
const SECONDARY_THEME_COLOR = "#0a6b5e";
const TERTIARY_THEME_COLOR = "#864700";

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
  // biome-ignore lint/complexity/useArrowFunction: constructor mock; vitest 4 rejects arrow impls when called with `new` (`() => ({...}) is not a constructor`)
  Queue: vi.fn().mockImplementation(function () {
    return { add: mockQueueAdd };
  }),
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
  // Belt-and-suspenders: the Epic-#286 logo tests clean up after
  // themselves in their own `finally`, but a mid-test failure could
  // leave a row + dangling tenants.logo_asset_id behind. Clearing here
  // keeps the suite re-runnable on a long-lived dev DB.
  await db.execute(sql`UPDATE tenants SET logo_asset_id = NULL WHERE id = ${ORG_A}`);
  await db.execute(sql`DELETE FROM org_branding_assets WHERE org_id = ${ORG_A}`);
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

describe("GET /v1/campaigns/:id/public-page", () => {
  it("returns the current config for an authenticated admin", async () => {
    const campaign = await createTestCampaign("Public Page Test Admin GET");
    const token = signToken(app);

    await app.inject({
      method: "PUT",
      url: `/v1/campaigns/${campaign.id}/public-page`,
      headers: authHeader(token),
      payload: {
        title: "Admin Page",
        description: "Draft copy",
        colorPrimary: PRIMARY_THEME_COLOR,
        goalAmountCents: 250000,
        status: "draft",
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${campaign.id}/public-page`,
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { title: string; status: string; description: string } }>();
    expect(body.data.title).toBe("Admin Page");
    expect(body.data.status).toBe("draft");
    expect(body.data.description).toBe("Draft copy");
  });

  it("returns 404 when no config exists yet", async () => {
    const campaign = await createTestCampaign("Public Page Test Missing Admin GET");
    const token = signToken(app);

    const res = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${campaign.id}/public-page`,
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 403 for a non-admin user", async () => {
    const campaign = await createTestCampaign("Public Page Test Forbidden Admin GET");
    const token = signToken(app, { role: "user" });

    const res = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${campaign.id}/public-page`,
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(403);
  });
});

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
        colorPrimary: SECONDARY_THEME_COLOR,
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

  it("returns 403 for a non-admin user", async () => {
    const campaign = await createTestCampaign("Public Page Test Forbidden Admin PUT");
    const token = signToken(app, { role: "user" });

    const res = await app.inject({
      method: "PUT",
      url: `/v1/campaigns/${campaign.id}/public-page`,
      headers: authHeader(token),
      payload: { title: "Forbidden Page", colorPrimary: TERTIARY_THEME_COLOR },
    });

    expect(res.statusCode).toBe(403);
  });

  it("returns fieldErrors for invalid public page payloads", async () => {
    const campaign = await createTestCampaign("Public Page Test Validation");
    const token = signToken(app);

    const res = await app.inject({
      method: "PUT",
      url: `/v1/campaigns/${campaign.id}/public-page`,
      headers: authHeader(token),
      payload: {
        title: "Valid title",
        colorPrimary: "#123456",
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{
      detail: string;
      fieldErrors?: Record<string, string>;
    }>();
    expect(body.detail).toContain("Validation failed");
    expect(body.fieldErrors?.colorPrimary).toBeDefined();
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
        colorPrimary: PRIMARY_THEME_COLOR,
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
      data: {
        title: string;
        description: string;
        goalAmountCents: number;
        stripeAccountId: string | null;
        raisedCents: number;
        donorCount: number;
      };
    }>();
    expect(body.data.title).toBe("Public Campaign");
    expect(body.data.description).toBe("Donate now");
    expect(body.data.goalAmountCents).toBe(100000);
    // Issue #197: connected account id is exposed so the donor SDK can
    // bind to it (post-3DS retrieve, intent confirmation).
    expect(body.data.stripeAccountId).toBe("acct_test_org_a");
    // Issue #200: aggregate fields default to 0 when no cleared donations
    // exist for the campaign yet — fresh campaigns mustn't crash the hero.
    expect(body.data.raisedCents).toBe(0);
    expect(body.data.donorCount).toBe(0);
  });

  it("caches the published page in Redis for 30s (PR #193 finding #4)", async () => {
    // Lock the cache contract: a second call within the TTL returns the
    // same payload even if the underlying DB row has been deleted out
    // from under us. This both proves the cache layer is wired AND
    // catches any future refactor that accidentally bypasses it (the
    // public hero is the highest-traffic endpoint we have).
    const campaign = await createTestCampaign("Public Page Test Cached");
    const token = signToken(app);

    await app.inject({
      method: "PUT",
      url: `/v1/campaigns/${campaign.id}/public-page`,
      headers: authHeader(token),
      payload: { title: "Cached Campaign", status: "published" },
    });

    // Prime the cache.
    const first = await app.inject({
      method: "GET",
      url: `/v1/public/campaigns/${campaign.id}/page`,
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json<{ data: { title: string } }>();
    expect(firstBody.data.title).toBe("Cached Campaign");

    // Delete the page from the DB, bypassing any application-level cache
    // invalidation. The next request MUST still return the cached
    // response — that's the point of the cache.
    await db.execute(sql`DELETE FROM campaign_public_pages WHERE campaign_id = ${campaign.id}`);

    const second = await app.inject({
      method: "GET",
      url: `/v1/public/campaigns/${campaign.id}/page`,
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json<{ data: { title: string } }>();
    expect(secondBody.data.title).toBe("Cached Campaign");
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

  it("returns 400 for an invalid campaign id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/public/campaigns//page",
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{
      detail: string;
      fieldErrors?: Record<string, string>;
    }>();
    expect(body.detail).toContain("Validation failed");
    expect(body.fieldErrors?.id).toBeDefined();
  });

  // ── Org branding (Epic #286) ────────────────────────────────────────────
  // The donor page surfaces the active org logo so postal-letter →
  // donation-page brand continuity holds (issue's headline value). Two
  // shapes to lock in: (a) `organisationLogoUrl` is the brandingPublicUrl
  // of the `public-hero` variant when a ready logo is configured, and
  // (b) it is `null` when the tenant has no `logo_asset_id` set.
  // `organisationId` is always present so the frontend can seed the
  // deterministic colour of the initial-letter fallback regardless of
  // logo state.
  describe("org branding payload (Epic #286)", () => {
    it("exposes organisationLogoUrl when a ready logo asset is active", async () => {
      const campaign = await createTestCampaign("Public Page Test Logo Active");
      const token = signToken(app);

      // Insert a logo asset row in `status='ready'` with a valid
      // variants jsonb keyed by `public-hero` and point the tenant at
      // it. The branding upload pipeline normally drives this from the
      // worker; the test substitutes the pipeline output directly so we
      // exercise the public-page query in isolation.
      const heroKey = `${ORG_A}/logo/test-hero/public-hero.webp`;
      const inserted = await db.execute<{ id: string }>(sql`
        INSERT INTO org_branding_assets (
          org_id, asset_type, status, original_key, original_content_type,
          variants
        ) VALUES (
          ${ORG_A},
          'org_logo',
          'ready',
          ${`${ORG_A}/logo/test-hero/original.png`},
          'image/png',
          ${JSON.stringify({
            "public-hero": {
              key: heroKey,
              contentType: "image/webp",
              width: 800,
              height: 800,
            },
          })}::jsonb
        )
        RETURNING id
      `);
      const assetId = inserted.rows?.[0]?.id;
      expect(assetId).toBeDefined();
      await db.execute(sql`UPDATE tenants SET logo_asset_id = ${assetId} WHERE id = ${ORG_A}`);

      try {
        await app.inject({
          method: "PUT",
          url: `/v1/campaigns/${campaign.id}/public-page`,
          headers: authHeader(token),
          payload: { title: "Logo Campaign", status: "published" },
        });

        const res = await app.inject({
          method: "GET",
          url: `/v1/public/campaigns/${campaign.id}/page`,
        });

        expect(res.statusCode).toBe(200);
        const body = res.json<{
          data: {
            organisationId: string;
            organisationLogoUrl: string | null;
          };
        }>();
        // organisationId is the tenant uuid — the donor frontend uses
        // it as the seed for the deterministic-colour initial-letter
        // avatar fallback.
        expect(body.data.organisationId).toBe(ORG_A);
        // organisationLogoUrl is the brandingPublicUrl of the
        // `public-hero` variant key. The test env points
        // S3_ENDPOINT/S3_BRANDING_BUCKET at MinIO; the suffix should
        // be the variant key verbatim.
        expect(body.data.organisationLogoUrl).not.toBeNull();
        expect(body.data.organisationLogoUrl).toContain(heroKey);
      } finally {
        await db.execute(sql`UPDATE tenants SET logo_asset_id = NULL WHERE id = ${ORG_A}`);
        if (assetId) {
          await db.execute(sql`DELETE FROM org_branding_assets WHERE id = ${assetId}`);
        }
      }
    });

    it("returns null organisationLogoUrl when the tenant has no logo configured", async () => {
      // Belt-and-suspenders — the previous test cleans up after itself
      // in `finally`, but the cache layer (30s TTL) could carry a stale
      // payload across describe blocks; work on a fresh campaign id so
      // we hit `loadPublicPage` fresh.
      await db.execute(sql`UPDATE tenants SET logo_asset_id = NULL WHERE id = ${ORG_A}`);
      const campaign = await createTestCampaign("Public Page Test Logo Absent");
      const token = signToken(app);

      await app.inject({
        method: "PUT",
        url: `/v1/campaigns/${campaign.id}/public-page`,
        headers: authHeader(token),
        payload: { title: "No Logo Campaign", status: "published" },
      });

      const res = await app.inject({
        method: "GET",
        url: `/v1/public/campaigns/${campaign.id}/page`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{
        data: {
          organisationId: string;
          organisationLogoUrl: string | null;
        };
      }>();
      expect(body.data.organisationId).toBe(ORG_A);
      // No logo configured → frontend renders the initial-letter
      // fallback. The shape stays consistent (`null`, not `undefined`)
      // so the consumer doesn't have to handle the missing-key case.
      expect(body.data.organisationLogoUrl).toBeNull();
    });
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
    const body = res.json<{ data: { clientSecret: string; stripeAccountId: string } }>();
    expect(body.data.clientSecret).toBe("pi_test_123_secret_abc");
    // Connect direct-charge: client must know which connected account
    // it's confirming against, so Stripe.js can pass `stripeAccount`.
    expect(body.data.stripeAccountId).toBe("acct_test_org_a");

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

  it("accepts a non-EUR presentment currency, case-insensitively (finding #5)", async () => {
    const campaign = await createTestCampaign("Public Page Test Donate GBP");
    const token = signToken(app);
    await app.inject({
      method: "PUT",
      url: `/v1/campaigns/${campaign.id}/public-page`,
      headers: authHeader(token),
      payload: { title: "Donate Page", status: "published" },
    });

    // Lowercase "gbp" used to 400 against the 3-literal EUR/GBP/CHF union.
    const res = await app.inject({
      method: "POST",
      url: `/v1/public/campaigns/${campaign.id}/donate`,
      payload: {
        amountCents: 5000,
        currency: "gbp",
        email: "donor@example.org",
        firstName: "Jane",
        lastName: "Doe",
      },
    });
    expect(res.statusCode).toBe(200);
    // Stripe is always called with the lowercase ISO code.
    expect(mockPaymentIntentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ currency: "gbp" }),
      expect.any(Object),
    );
  });

  it("rejects a currency not enabled in currency_metadata (finding #5)", async () => {
    const campaign = await createTestCampaign("Public Page Test Donate Bad Currency");
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
      payload: {
        amountCents: 5000,
        currency: "xyz",
        email: "donor@example.org",
        firstName: "Jane",
        lastName: "Doe",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ title: string }>().title).toBe("invalid_currency");
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

  // The two error paths below are the most common production failures
  // (NPO clicks Connect Stripe but bails halfway, or Stripe disables
  // their account). They were untested before — the QA review surfaced
  // the gap. Both must mask to 502 + RFC 9457 body — no Stripe internal
  // detail leaks (donor sees a generic message), and the body shape is
  // locked so a regression to a plain-string response would fail the test.
  it("returns 502 with RFC 9457 body when the tenant has no stripe_account_id (onboarding never started)", async () => {
    const campaign = await createTestCampaign("Public Page Test Not Onboarded");
    const token = signToken(app);
    await app.inject({
      method: "PUT",
      url: `/v1/campaigns/${campaign.id}/public-page`,
      headers: authHeader(token),
      payload: { title: "Donate Page", status: "published" },
    });

    // Wipe the seed's stripe account so `createDonationIntent` hits the
    // "Organization has not completed Stripe onboarding" branch.
    await db.execute(sql`UPDATE tenants SET stripe_account_id = NULL WHERE id = ${ORG_A}`);
    try {
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

      expect(res.statusCode).toBe(502);
      const body = res.json<{ type: string; title: string; status: number; detail: string }>();
      expect(body.type).toBe("https://httpproblems.com/http-status/502");
      expect(body.title).toBe("Bad Gateway");
      expect(body.status).toBe(502);
      expect(body.detail).toBe("Payment processing failed");
      // Donor must NOT see the underlying Stripe-onboarding message.
      expect(body.detail).not.toContain("onboarding");
    } finally {
      // Restore the fixture so subsequent tests in the file pass.
      await db.execute(
        sql`UPDATE tenants SET stripe_account_id = 'acct_test_org_a' WHERE id = ${ORG_A}`,
      );
    }
  });

  it("returns 502 with RFC 9457 body when the connected account has charges disabled", async () => {
    const campaign = await createTestCampaign("Public Page Test Charges Disabled");
    const token = signToken(app);
    await app.inject({
      method: "PUT",
      url: `/v1/campaigns/${campaign.id}/public-page`,
      headers: authHeader(token),
      payload: { title: "Donate Page", status: "published" },
    });

    // Stub the per-test Stripe `accounts.retrieve` to return charges_enabled=false
    mockGetStripe.mockReturnValueOnce({
      paymentIntents: { create: mockPaymentIntentsCreate },
      accounts: {
        retrieve: vi.fn().mockResolvedValue({ charges_enabled: false }),
      },
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

    expect(res.statusCode).toBe(502);
    const body = res.json<{ type: string; title: string; status: number; detail: string }>();
    expect(body.type).toBe("https://httpproblems.com/http-status/502");
    expect(body.status).toBe(502);
    expect(body.detail).toBe("Payment processing failed");
    expect(body.detail).not.toContain("fully onboarded");
    // Stripe wasn't asked to create a PaymentIntent — we short-circuited
    // before that on the charges_enabled check.
    expect(mockPaymentIntentsCreate).not.toHaveBeenCalled();
  });
});
