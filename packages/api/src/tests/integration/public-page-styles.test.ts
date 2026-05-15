/**
 * Public donation page style-archetype integration tests (Epic #362, PR-2).
 *
 * Five surfaces covered:
 *
 *   1. **Enum / registry parity** — the Postgres enum (migration 0054)
 *      and the const-tuple `PUBLIC_PAGE_STYLE_KEYS` in
 *      `@givernance/shared/constants` are two halves of the same source
 *      of truth. A test asserts the live enum equals the registry; drift
 *      fails CI.
 *
 *   2. **Public endpoint flag-gating** — `GET /v1/public/campaigns/:id/page`
 *      returns `publicPageStyle: null` when the
 *      `donation.public_page_styles` flag is OFF for the campaign's
 *      tenant. With the flag ON it returns the three-layer-resolved value.
 *      The pattern is "field-level gate," not "404 the route," because
 *      the public endpoint existed before this Epic and must keep
 *      serving the page for tenants who haven't opted in.
 *
 *   3. **Admin PUT field-level gate** — the existing
 *      `PUT /v1/campaigns/:id/public-page` route stays open for legacy
 *      fields (title / colour / goal) even when the flag is off; the
 *      gate is field-level (`publicPageStyle in body && flag off → 400`).
 *      Non-style PUT bodies are unaffected.
 *
 *   4. **Tenant default routes** — `GET / PATCH /v1/org/style-default`
 *      are gated by `requireFlag(...)` as their FIRST preHandler. With
 *      the flag off both return 404 (anti-disclosure). With the flag on,
 *      they obey the existing `requireOrgAdmin` posture (404 for
 *      non-admins by the same anti-disclosure pattern in this codebase,
 *      since the platform follows it for the rest of the admin surface).
 *
 *   5. **Validation** — unknown style keys are rejected at the
 *      validator layer (400) before reaching the service; `null` is
 *      accepted as the explicit-clear value; omitted is no-op on PUT.
 *
 * Lifecycle: tests flip the flag on/off via direct DB write +
 * `flagService.invalidate()` (matches the bulk-email feature-flag
 * test pattern). Every test resets the flag to its seeded OFF state
 * in `afterEach` so the parity guarantee holds for the next suite.
 */

import { FEATURE_FLAG_KEYS, PUBLIC_PAGE_STYLE_KEYS } from "@givernance/shared/constants";
import { featureFlags } from "@givernance/shared/schema";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";
import { flagService } from "../../lib/flags/flag-service.js";
import { createServer } from "../../server.js";
import {
  authHeader,
  ensureTestTenants,
  ORG_A,
  ORG_B,
  signToken,
  signTokenB,
} from "../helpers/auth.js";

let app: FastifyInstance;

const FLAG_KEY = FEATURE_FLAG_KEYS.DONATION_PUBLIC_PAGE_STYLES;

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();
  // Ensure tenant A has a Stripe account so the public-page query
  // hits the tenants join successfully (the unit-of-test here is the
  // style field, not Stripe wiring).
  await db.execute(
    sql`UPDATE tenants SET stripe_account_id = 'acct_test_org_a' WHERE id = ${ORG_A}`,
  );
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM campaign_public_pages WHERE org_id = ${ORG_A}`);
  await db.execute(sql`DELETE FROM campaigns WHERE org_id = ${ORG_A} AND name LIKE 'Style Test%'`);
  await db.execute(sql`UPDATE tenants SET default_public_page_style = NULL WHERE id = ${ORG_A}`);
  await db.execute(sql`UPDATE tenants SET default_public_page_style = NULL WHERE id = ${ORG_B}`);
  // Leave the flag in its seeded state so subsequent suites see a
  // deterministic starting point.
  await db.update(featureFlags).set({ enabled: false }).where(eq(featureFlags.key, FLAG_KEY));
  await flagService.invalidate();
  await app.close();
});

beforeEach(async () => {
  // Each test starts with the flag OFF and BOTH tenants' defaults
  // cleared. Includes org-B so the cross-tenant defence test
  // observes a clean precondition.
  await db.update(featureFlags).set({ enabled: false }).where(eq(featureFlags.key, FLAG_KEY));
  await db.execute(sql`UPDATE tenants SET default_public_page_style = NULL WHERE id = ${ORG_A}`);
  await db.execute(sql`UPDATE tenants SET default_public_page_style = NULL WHERE id = ${ORG_B}`);
  await flagService.invalidate();
});

afterEach(async () => {
  await db.update(featureFlags).set({ enabled: false }).where(eq(featureFlags.key, FLAG_KEY));
  await flagService.invalidate();
});

async function flipFlagOn() {
  await db.update(featureFlags).set({ enabled: true }).where(eq(featureFlags.key, FLAG_KEY));
  await flagService.invalidate();
}

async function createCampaign(name: string): Promise<{ id: string }> {
  const token = signToken(app);
  const res = await app.inject({
    method: "POST",
    url: "/v1/campaigns",
    headers: authHeader(token),
    payload: { name, type: "digital" },
  });
  return res.json<{ data: { id: string } }>().data;
}

async function publishPage(campaignId: string, body: Record<string, unknown> = {}): Promise<void> {
  const token = signToken(app);
  await app.inject({
    method: "PUT",
    url: `/v1/campaigns/${campaignId}/public-page`,
    headers: authHeader(token),
    payload: { title: "Style Test", status: "published", ...body },
  });
}

// ─── 1. Enum / registry parity ───────────────────────────────────────

describe("Public-page style enum + registry parity", () => {
  it("PUBLIC_PAGE_STYLE_KEYS matches the Postgres enum values (migration 0054)", async () => {
    const result = await db.execute<{ enum_value: string }>(sql`
      SELECT unnest(enum_range(NULL::public_page_style))::text AS enum_value
    `);
    const dbValues = result.rows.map((r) => r.enum_value).sort();
    const codeValues = [...PUBLIC_PAGE_STYLE_KEYS].sort();
    expect(
      dbValues,
      "Postgres public_page_style enum drifted from PUBLIC_PAGE_STYLE_KEYS — add a NEW migration (not a modification of 0054) to align",
    ).toEqual(codeValues);
  });
});

// ─── 2. Public endpoint flag-gating ──────────────────────────────────

describe("GET /v1/public/campaigns/:id/page — publicPageStyle field", () => {
  it("returns publicPageStyle: null when the flag is OFF", async () => {
    const campaign = await createCampaign("Style Test FlagOff");
    await publishPage(campaign.id);
    // Direct DB set so the persistence is independent of any flag
    // gate that may incidentally swallow the value.
    await db.execute(
      sql`UPDATE campaigns SET public_page_style = 'activist' WHERE id = ${campaign.id}`,
    );

    const res = await app.inject({
      method: "GET",
      url: `/v1/public/campaigns/${campaign.id}/page`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { publicPageStyle: string | null } }>();
    expect(body.data.publicPageStyle).toBeNull();
  });

  it("returns the resolved publicPageStyle when the flag is ON", async () => {
    const campaign = await createCampaign("Style Test FlagOn Campaign");
    await publishPage(campaign.id);
    await db.execute(
      sql`UPDATE campaigns SET public_page_style = 'activist' WHERE id = ${campaign.id}`,
    );
    await flipFlagOn();

    const res = await app.inject({
      method: "GET",
      url: `/v1/public/campaigns/${campaign.id}/page`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { publicPageStyle: string | null } }>();
    expect(body.data.publicPageStyle).toBe("activist");
  });

  it("falls back to the tenant default when no campaign override is set", async () => {
    const campaign = await createCampaign("Style Test Tenant Default");
    await publishPage(campaign.id);
    await db.execute(
      sql`UPDATE tenants SET default_public_page_style = 'civic-modern' WHERE id = ${ORG_A}`,
    );
    await flipFlagOn();

    const res = await app.inject({
      method: "GET",
      url: `/v1/public/campaigns/${campaign.id}/page`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { publicPageStyle: string | null } }>();
    expect(body.data.publicPageStyle).toBe("civic-modern");
  });

  it("falls back to 'foundation' when neither campaign nor tenant has a value", async () => {
    const campaign = await createCampaign("Style Test Hardcoded Default");
    await publishPage(campaign.id);
    await flipFlagOn();

    const res = await app.inject({
      method: "GET",
      url: `/v1/public/campaigns/${campaign.id}/page`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { publicPageStyle: string | null } }>();
    expect(body.data.publicPageStyle).toBe("foundation");
  });
});

// ─── 3. Admin PUT field-level gate ───────────────────────────────────

describe("PUT /v1/campaigns/:id/public-page — publicPageStyle field gate", () => {
  it("rejects publicPageStyle in body when the flag is OFF (400, not silent)", async () => {
    const campaign = await createCampaign("Style Test PUT FlagOff");
    const token = signToken(app);

    const res = await app.inject({
      method: "PUT",
      url: `/v1/campaigns/${campaign.id}/public-page`,
      headers: authHeader(token),
      payload: {
        title: "X",
        status: "draft",
        publicPageStyle: "activist",
      },
    });
    expect(res.statusCode).toBe(400);
    // PR-2 review: assert on the `field` discriminator (RFC 9457
    // extension, precedent in bank-accounts/routes.ts) rather than the
    // user-facing title copy — copy can change without breaking the
    // contract this test locks in. Also: the response MUST NOT leak
    // the literal flag key in any operator-facing string.
    const body = res.json<{
      type: string;
      title: string;
      status: number;
      detail: string;
      field?: string;
      reason?: string;
    }>();
    expect(body.status).toBe(400);
    expect(body.field).toBe("publicPageStyle");
    expect(body.reason).toBe("feature_not_available");
    expect(body.detail).not.toContain("donation.public_page_styles");
    expect(body.title).not.toContain("donation.public_page_styles");
  });

  it("accepts publicPageStyle when the flag is ON; persists it on the campaign row", async () => {
    const campaign = await createCampaign("Style Test PUT FlagOn");
    const token = signToken(app);
    await flipFlagOn();

    const res = await app.inject({
      method: "PUT",
      url: `/v1/campaigns/${campaign.id}/public-page`,
      headers: authHeader(token),
      payload: {
        title: "Activist Campaign",
        status: "published",
        publicPageStyle: "activist",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { publicPageStyle: string | null } }>();
    expect(body.data.publicPageStyle).toBe("activist");

    // Round-trip: the donor-facing endpoint should now emit the value.
    const publicRes = await app.inject({
      method: "GET",
      url: `/v1/public/campaigns/${campaign.id}/page`,
    });
    const publicBody = publicRes.json<{ data: { publicPageStyle: string | null } }>();
    expect(publicBody.data.publicPageStyle).toBe("activist");
  });

  it("explicit null clears the per-campaign override (inherit from tenant)", async () => {
    const campaign = await createCampaign("Style Test PUT Null");
    const token = signToken(app);
    await flipFlagOn();
    // First set it to a value.
    await app.inject({
      method: "PUT",
      url: `/v1/campaigns/${campaign.id}/public-page`,
      headers: authHeader(token),
      payload: { title: "X", status: "draft", publicPageStyle: "neo-brutalist" },
    });
    // Then clear it explicitly.
    const res = await app.inject({
      method: "PUT",
      url: `/v1/campaigns/${campaign.id}/public-page`,
      headers: authHeader(token),
      payload: { title: "X", status: "draft", publicPageStyle: null },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { publicPageStyle: string | null } }>();
    expect(body.data.publicPageStyle).toBeNull();
  });

  it("omitting publicPageStyle leaves the existing value untouched", async () => {
    const campaign = await createCampaign("Style Test PUT Untouched");
    const token = signToken(app);
    await flipFlagOn();
    await app.inject({
      method: "PUT",
      url: `/v1/campaigns/${campaign.id}/public-page`,
      headers: authHeader(token),
      payload: { title: "X", status: "draft", publicPageStyle: "calm-wellness" },
    });
    // Second PUT without publicPageStyle in body.
    const res = await app.inject({
      method: "PUT",
      url: `/v1/campaigns/${campaign.id}/public-page`,
      headers: authHeader(token),
      payload: { title: "Y", status: "draft" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { publicPageStyle: string | null } }>();
    expect(body.data.publicPageStyle).toBe("calm-wellness");
  });

  it("rejects an unknown style key at the validator layer (400)", async () => {
    const campaign = await createCampaign("Style Test PUT Bad Key");
    const token = signToken(app);
    await flipFlagOn();

    const res = await app.inject({
      method: "PUT",
      url: `/v1/campaigns/${campaign.id}/public-page`,
      headers: authHeader(token),
      payload: { title: "X", status: "draft", publicPageStyle: "not-a-real-style" },
    });
    // Fastify TypeBox schema validation kicks in before the route
    // handler runs; the resulting 400 carries the validation error
    // shape, not the route-level problem-detail.
    expect(res.statusCode).toBe(400);
  });

  it("legacy PUT (no publicPageStyle) keeps working with the flag OFF", async () => {
    const campaign = await createCampaign("Style Test PUT Legacy");
    const token = signToken(app);
    // Flag stays OFF (default state).

    const res = await app.inject({
      method: "PUT",
      url: `/v1/campaigns/${campaign.id}/public-page`,
      headers: authHeader(token),
      payload: { title: "Legacy", status: "draft" },
    });
    expect(res.statusCode).toBe(200);
    // No regression: the existing fields round-trip normally.
    const body = res.json<{ data: { title: string; publicPageStyle: string | null } }>();
    expect(body.data.title).toBe("Legacy");
    expect(body.data.publicPageStyle).toBeNull();
  });
});

// ─── 4. Tenant default routes ────────────────────────────────────────

describe("GET / PATCH /v1/org/style-default — flag-gated, org-admin-only", () => {
  it("GET returns 404 when the flag is OFF (anti-disclosure)", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/org/style-default",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(404);
  });

  it("PATCH returns 404 when the flag is OFF (anti-disclosure)", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/org/style-default",
      headers: authHeader(token),
      payload: { defaultPublicPageStyle: "activist" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET returns the current value when the flag is ON", async () => {
    await flipFlagOn();
    await db.execute(
      sql`UPDATE tenants SET default_public_page_style = 'retro-print' WHERE id = ${ORG_A}`,
    );
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/org/style-default",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { defaultPublicPageStyle: string | null } }>();
    expect(body.data.defaultPublicPageStyle).toBe("retro-print");
  });

  it("GET returns null when the tenant hasn't picked a default", async () => {
    await flipFlagOn();
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/org/style-default",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { defaultPublicPageStyle: string | null } }>();
    expect(body.data.defaultPublicPageStyle).toBeNull();
  });

  it("PATCH sets the tenant default to a valid key", async () => {
    await flipFlagOn();
    const token = signToken(app);
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/org/style-default",
      headers: authHeader(token),
      payload: { defaultPublicPageStyle: "cosmic-gradient" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { defaultPublicPageStyle: string | null } }>();
    expect(body.data.defaultPublicPageStyle).toBe("cosmic-gradient");

    // Round-trip via GET.
    const getRes = await app.inject({
      method: "GET",
      url: "/v1/org/style-default",
      headers: authHeader(token),
    });
    const getBody = getRes.json<{ data: { defaultPublicPageStyle: string | null } }>();
    expect(getBody.data.defaultPublicPageStyle).toBe("cosmic-gradient");
  });

  it("PATCH null clears the tenant default", async () => {
    await flipFlagOn();
    await db.execute(
      sql`UPDATE tenants SET default_public_page_style = 'editorial-story' WHERE id = ${ORG_A}`,
    );
    const token = signToken(app);
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/org/style-default",
      headers: authHeader(token),
      payload: { defaultPublicPageStyle: null },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { defaultPublicPageStyle: string | null } }>();
    expect(body.data.defaultPublicPageStyle).toBeNull();
  });

  it("PATCH rejects an unknown style key at the validator layer", async () => {
    await flipFlagOn();
    const token = signToken(app);
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/org/style-default",
      headers: authHeader(token),
      payload: { defaultPublicPageStyle: "definitely-not-a-style" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PATCH returns 403 for a non-org-admin user when flag is ON", async () => {
    await flipFlagOn();
    const token = signToken(app, { role: "user" });
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/org/style-default",
      headers: authHeader(token),
      payload: { defaultPublicPageStyle: "minimal-checkout" },
    });
    // `requireOrgAdmin` is the second preHandler — it 403s for `user`
    // role. We deliberately don't 404 here because the flag IS on:
    // the route exists, but this caller doesn't have permission. The
    // anti-disclosure 404 only applies when the *route itself* should
    // appear not to exist (flag off).
    expect(res.statusCode).toBe(403);
  });
});

// ─── 5. Closed-set contract assertions ───────────────────────────────

describe("Response contract — publicPageStyle values are closed set", () => {
  it("returned values are always one of PUBLIC_PAGE_STYLE_KEYS (or null)", async () => {
    const campaign = await createCampaign("Style Test Closed Set");
    await publishPage(campaign.id);
    await db.execute(
      sql`UPDATE campaigns SET public_page_style = 'cosmic-gradient' WHERE id = ${campaign.id}`,
    );
    await flipFlagOn();

    const res = await app.inject({
      method: "GET",
      url: `/v1/public/campaigns/${campaign.id}/page`,
    });
    const body = res.json<{ data: { publicPageStyle: string | null } }>();
    // A regression that emitted (e.g.) "cosmic-gradient-v2" would
    // satisfy every per-case `toBe(...)` test if the DB carried it.
    // This pins the wire shape to the curated registry.
    expect(body.data.publicPageStyle).not.toBeNull();
    expect(PUBLIC_PAGE_STYLE_KEYS as readonly string[]).toContain(
      body.data.publicPageStyle as string,
    );
  });
});

// ─── 6. Cross-tenant defence ─────────────────────────────────────────

describe("Cross-tenant defence — org A cannot mutate org B's tenant default", () => {
  it("org-A's PATCH carries org-A's JWT orgId; org-B's tenants row is untouched", async () => {
    // Even though `tenants` is owner-only at the SQL grant level
    // (mig 0005 grants UPDATE to `givernance_app` on every table),
    // the route's `request.auth.orgId` is the JWT-derived value and
    // the service-layer `WHERE id = orgId` predicate scopes the
    // UPDATE to that tenant. This test pins the invariant: org-A
    // cannot reach org-B's row even when the JWT orgId IS org-A.
    // A future refactor that drops the predicate would surface here.
    await flipFlagOn();

    // Pre-state: org-B has its own default.
    await db.execute(
      sql`UPDATE tenants SET default_public_page_style = 'editorial-story' WHERE id = ${ORG_B}`,
    );

    // Org-A operator PATCHes their own default.
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/org/style-default",
      headers: authHeader(tokenA),
      payload: { defaultPublicPageStyle: "minimal-checkout" },
    });
    expect(res.statusCode).toBe(200);

    // Org-B's value MUST be unchanged.
    const orgBResult = await db.execute<{ default_public_page_style: string | null }>(
      sql`SELECT default_public_page_style FROM tenants WHERE id = ${ORG_B}`,
    );
    expect(orgBResult.rows[0]?.default_public_page_style).toBe("editorial-story");

    // Org-A's value MUST be the new one.
    const orgAResult = await db.execute<{ default_public_page_style: string | null }>(
      sql`SELECT default_public_page_style FROM tenants WHERE id = ${ORG_A}`,
    );
    expect(orgAResult.rows[0]?.default_public_page_style).toBe("minimal-checkout");

    // And org-B's own GET sees their unchanged value through the API.
    const tokenB = signTokenB(app);
    const getRes = await app.inject({
      method: "GET",
      url: "/v1/org/style-default",
      headers: authHeader(tokenB),
    });
    expect(getRes.statusCode).toBe(200);
    const getBody = getRes.json<{ data: { defaultPublicPageStyle: string | null } }>();
    expect(getBody.data.defaultPublicPageStyle).toBe("editorial-story");
  });
});
