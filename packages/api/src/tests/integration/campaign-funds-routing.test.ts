/**
 * Campaign fund routing integration tests (Epic #416, Task 4).
 *
 * Covers:
 *   - Feature flag gate: routes return 404 when flag is off
 *   - GET returns empty array for a campaign with no routing entries
 *   - POST adds a fund with isOnlineDefault = true
 *   - Invariant enforcement: 2 funds without a valid online-default → 422
 *   - DELETE removes an entry
 *   - Cross-campaign access returns 403/404
 */

import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { db } from "../helpers/db.js";

/**
 * Settlement-changing routes (campaign/fund bank links, campaign-funds routing)
 * now require the same MFA step-up as a bank-account mutation (B5), so the test
 * tokens carry acr=2 + a fresh auth_time.
 */
const stepUp = () => ({ acr: "2", auth_time: Math.floor(Date.now() / 1000) - 60 });

let app: FastifyInstance;

const VALID_CH_IBAN = "CH5604835012345678009";

const BASE_HOLDER = {
  holderName: "Association Givernance Routing Test",
  holderStreet: "Avenue du Routing",
  holderBuildingNumber: "5",
  holderPostalCode: "1200",
  holderTown: "Geneva",
  holderCountryCode: "CH",
};

let campaignId: string;
let campaignBId: string;
let fundId1: string;
let fundId2: string;

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();

  // Seed the fund_routing feature flag as enabled
  await db.execute(sql`
    INSERT INTO feature_flags (key, enabled, label, description, scope, tenant_override_allowed, public)
    VALUES ('donation.fund_routing', TRUE, 'Campaign fund routing', 'Multi-fund routing', 'platform', FALSE, FALSE)
    ON CONFLICT (key) DO UPDATE SET enabled = TRUE
  `);
  await flagService.invalidate();

  // Clean state to avoid re-run and cross-test-file collisions.
  // Wipe ALL funds/bank_accounts for these orgs, not just 'Routing%'-prefixed ones,
  // because other test files (e.g. fund-bank-account.test.ts) may share the same
  // IBAN and leave rows behind if their afterAll doesn't clean up.
  await db.execute(sql`DELETE FROM campaign_funds WHERE org_id IN (${ORG_A}, ${ORG_B})`);
  await db.execute(
    sql`DELETE FROM campaigns WHERE org_id IN (${ORG_A}, ${ORG_B}) AND name LIKE 'Routing Test%'`,
  );
  await db.execute(
    sql`DELETE FROM donation_allocations WHERE fund_id IN (SELECT id FROM funds WHERE org_id IN (${ORG_A}, ${ORG_B}))`,
  );
  await db.execute(sql`DELETE FROM funds WHERE org_id IN (${ORG_A}, ${ORG_B})`);
  await db.execute(sql`DELETE FROM bank_accounts WHERE org_id IN (${ORG_A}, ${ORG_B})`);

  const tokenA = signToken(app, {
    acr: "2",
    auth_time: Math.floor(Date.now() / 1000) - 60,
  });

  // Create a bank account so funds can have a settlement currency
  const bankRes = await app.inject({
    method: "POST",
    url: "/v1/bank-accounts",
    headers: authHeader(tokenA),
    payload: {
      ...BASE_HOLDER,
      label: "Routing Test Bank Account",
      iban: VALID_CH_IBAN,
      currency: "CHF",
    },
  });
  expect(bankRes.statusCode).toBe(201);
  const bankAccountId = bankRes.json<{ data: { id: string } }>().data.id;

  // Create a campaign for ORG_A
  const campaignRes = await app.inject({
    method: "POST",
    url: "/v1/campaigns",
    headers: authHeader(signToken(app, stepUp())),
    payload: { name: "Routing Test Campaign A", type: "digital", defaultCurrency: "CHF" },
  });
  expect(campaignRes.statusCode).toBe(201);
  campaignId = campaignRes.json<{ data: { id: string } }>().data.id;

  // Create a campaign for ORG_B (for cross-campaign access test)
  const campaignBRes = await app.inject({
    method: "POST",
    url: "/v1/campaigns",
    headers: authHeader(signTokenB(app, stepUp())),
    payload: { name: "Routing Test Campaign B", type: "digital", defaultCurrency: "EUR" },
  });
  expect(campaignBRes.statusCode).toBe(201);
  campaignBId = campaignBRes.json<{ data: { id: string } }>().data.id;

  // Create two funds for ORG_A
  const fund1Res = await app.inject({
    method: "POST",
    url: "/v1/funds",
    headers: authHeader(signToken(app, stepUp())),
    payload: { name: "Routing Fund 1", type: "unrestricted", bankAccountId },
  });
  expect(fund1Res.statusCode).toBe(201);
  fundId1 = fund1Res.json<{ data: { id: string } }>().data.id;

  const fund2Res = await app.inject({
    method: "POST",
    url: "/v1/funds",
    headers: authHeader(signToken(app, stepUp())),
    payload: { name: "Routing Fund 2", type: "restricted", bankAccountId },
  });
  expect(fund2Res.statusCode).toBe(201);
  fundId2 = fund2Res.json<{ data: { id: string } }>().data.id;
});

afterAll(async () => {
  // Reset flag to off so other test suites are not affected
  await db.execute(sql`
    UPDATE feature_flags SET enabled = FALSE WHERE key = 'donation.fund_routing'
  `);
  await flagService.invalidate();
  await app.close();
});

describe("Campaign fund routing — flag gate", () => {
  it("GET /v1/campaigns/:id/funds/routing returns 404 when flag is off", async () => {
    // Temporarily disable the flag
    await db.execute(
      sql`UPDATE feature_flags SET enabled = FALSE WHERE key = 'donation.fund_routing'`,
    );
    await flagService.invalidate();

    const token = signToken(app, stepUp());
    const res = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${campaignId}/funds/routing`,
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(404);

    // Re-enable for subsequent tests
    await db.execute(
      sql`UPDATE feature_flags SET enabled = TRUE WHERE key = 'donation.fund_routing'`,
    );
    await flagService.invalidate();
  });
});

describe("Campaign fund routing — CRUD (flag on)", () => {
  it("GET /v1/campaigns/:id/funds/routing returns empty array initially", async () => {
    const token = signToken(app, stepUp());
    const res = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${campaignId}/funds/routing`,
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: unknown[] }>();
    expect(body.data).toEqual([]);
  });

  it("POST /v1/campaigns/:id/funds/routing adds a fund with isOnlineDefault = true", async () => {
    const token = signToken(app, stepUp());
    const res = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/funds/routing`,
      headers: authHeader(token),
      payload: { fundId: fundId1, isOnlineDefault: true },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{
      data: { fundId: string; isOnlineDefault: boolean; splitPct: string | null };
    }>();
    expect(body.data.fundId).toBe(fundId1);
    expect(body.data.isOnlineDefault).toBe(true);
    expect(body.data.splitPct).toBeNull(); // single fund → splitPct null is valid
  });

  it("POST second fund without splitPct or correct online-default setup triggers 422 invariant", async () => {
    const token = signToken(app, stepUp());
    // Adding fund2 without splitPct while fund1 also has no splitPct violates the multi-fund invariant
    const res = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/funds/routing`,
      headers: authHeader(token),
      payload: { fundId: fundId2, isOnlineDefault: false },
    });

    // With 2 funds and no splitPct on either → invariant violation
    expect(res.statusCode).toBe(422);
    const body = res.json<{ detail: string }>();
    expect(body.detail).toMatch(/split|percentage|invariant/i);
  });

  it("DELETE /v1/campaigns/:id/funds/routing/:fundId removes the entry", async () => {
    const token = signToken(app, stepUp());
    // There is one routing entry (fund1) — remove it
    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/v1/campaigns/${campaignId}/funds/routing/${fundId1}`,
      headers: authHeader(token),
    });

    expect(deleteRes.statusCode).toBe(204);

    // Verify it's gone
    const getRes = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${campaignId}/funds/routing`,
      headers: authHeader(token),
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json<{ data: unknown[] }>().data).toEqual([]);
  });

  it("GET /v1/campaigns/:id/funds/routing for a cross-org campaign returns 404", async () => {
    // ORG_A token trying to access ORG_B campaign
    const token = signToken(app, stepUp());
    const res = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${campaignBId}/funds/routing`,
      headers: authHeader(token),
    });

    // Campaign not found in ORG_A's context → 404
    expect(res.statusCode).toBe(404);
  });

  it("POST to cross-org campaign returns 404", async () => {
    const token = signToken(app, stepUp());
    const res = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignBId}/funds/routing`,
      headers: authHeader(token),
      payload: { fundId: fundId1, isOnlineDefault: true },
    });

    expect(res.statusCode).toBe(404);
  });
});
