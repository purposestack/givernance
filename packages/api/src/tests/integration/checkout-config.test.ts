/**
 * GET /v1/campaigns/:id/checkout-config integration tests (Epic #416, Task 15).
 *
 * The endpoint is PUBLIC (no auth required) and resolves the settlement
 * currency + candidate presentment currencies for the campaign's online-default
 * fund.
 *
 * Covers:
 *   - Flag off → 404
 *   - Flag on, campaign not found → 404
 *   - Flag on, campaign exists but no online-default fund → 422
 *   - Flag on, campaign fully configured → 200 with settlementCurrency + presentmentCurrencies
 */

import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";
import { flagService } from "../../lib/flags/flag-service.js";
import { createServer } from "../../server.js";
import { authHeader, ensureTestTenants, ORG_A, signToken } from "../helpers/auth.js";

let app: FastifyInstance;

const VALID_CH_IBAN = "CH3680808001234567890";

const BASE_HOLDER = {
  holderName: "Association Checkout Config Test",
  holderStreet: "Rue de Checkout",
  holderBuildingNumber: "99",
  holderPostalCode: "3000",
  holderTown: "Bern",
  holderCountryCode: "CH",
};

let campaignWithNoRouting: string;
let campaignWithRouting: string;
const NON_EXISTENT_CAMPAIGN_ID = "00000000-0000-0000-0000-ffffffffffff";

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();

  // Seed both required feature flags
  await db.execute(sql`
    INSERT INTO feature_flags (key, enabled, label, description, scope, tenant_override_allowed, public)
    VALUES
      ('donation.multi_currency', TRUE, 'Multi-currency checkout', 'Multi-currency checkout support', 'platform', FALSE, FALSE),
      ('donation.fund_routing', TRUE, 'Campaign fund routing', 'Multi-fund routing', 'platform', FALSE, FALSE)
    ON CONFLICT (key) DO UPDATE SET enabled = TRUE
  `);

  // Seed CHF in currency_metadata so the presentment list is non-empty
  await db.execute(sql`
    INSERT INTO currency_metadata (code, minor_unit, enabled, label)
    VALUES ('CHF', 2, TRUE, 'Swiss Franc')
    ON CONFLICT (code) DO UPDATE SET enabled = TRUE
  `);

  await flagService.invalidate();

  // Clean state
  await db.execute(sql`DELETE FROM campaign_funds WHERE org_id = ${ORG_A}`);
  await db.execute(
    sql`DELETE FROM campaigns WHERE org_id = ${ORG_A} AND name LIKE 'Checkout Config Test%'`,
  );
  await db.execute(sql`DELETE FROM funds WHERE org_id = ${ORG_A} AND name LIKE 'Checkout Config%'`);
  await db.execute(
    sql`DELETE FROM bank_accounts WHERE org_id = ${ORG_A} AND label LIKE 'Checkout Config%'`,
  );

  const tokenA = signToken(app, {
    acr: "urn:givernance:acr:bank-mutation",
    auth_time: Math.floor(Date.now() / 1000) - 60,
  });

  // Campaign with no routing entry
  const camp1Res = await app.inject({
    method: "POST",
    url: "/v1/campaigns",
    headers: authHeader(signToken(app)),
    payload: { name: "Checkout Config Test No Routing", type: "general", defaultCurrency: "CHF" },
  });
  expect(camp1Res.statusCode).toBe(201);
  campaignWithNoRouting = camp1Res.json<{ data: { id: string } }>().data.id;

  // Campaign with full routing setup
  const camp2Res = await app.inject({
    method: "POST",
    url: "/v1/campaigns",
    headers: authHeader(signToken(app)),
    payload: { name: "Checkout Config Test With Routing", type: "general", defaultCurrency: "CHF" },
  });
  expect(camp2Res.statusCode).toBe(201);
  campaignWithRouting = camp2Res.json<{ data: { id: string } }>().data.id;

  // Create a bank account
  const bankRes = await app.inject({
    method: "POST",
    url: "/v1/bank-accounts",
    headers: authHeader(tokenA),
    payload: {
      ...BASE_HOLDER,
      label: "Checkout Config Bank Account CHF",
      iban: VALID_CH_IBAN,
      currency: "CHF",
    },
  });
  expect(bankRes.statusCode).toBe(201);
  const bankAccountId = bankRes.json<{ data: { id: string } }>().data.id;

  // Create a fund linked to the bank account
  const fundRes = await app.inject({
    method: "POST",
    url: "/v1/funds",
    headers: authHeader(signToken(app)),
    payload: { name: "Checkout Config General Fund", type: "unrestricted", bankAccountId },
  });
  expect(fundRes.statusCode).toBe(201);
  const fundId = fundRes.json<{ data: { id: string } }>().data.id;

  // Add the fund to the campaign's routing as online-default
  const routingRes = await app.inject({
    method: "POST",
    url: `/v1/campaigns/${campaignWithRouting}/funds/routing`,
    headers: authHeader(signToken(app)),
    payload: { fundId, isOnlineDefault: true },
  });
  expect(routingRes.statusCode).toBe(201);
});

afterAll(async () => {
  // Reset flags to off
  await db.execute(sql`
    UPDATE feature_flags SET enabled = FALSE
    WHERE key IN ('donation.multi_currency', 'donation.fund_routing')
  `);
  await flagService.invalidate();
  await app.close();
});

describe("GET /v1/campaigns/:id/checkout-config (Epic #416 Task 15)", () => {
  it("returns 404 when donation.multi_currency flag is off", async () => {
    await db.execute(
      sql`UPDATE feature_flags SET enabled = FALSE WHERE key = 'donation.multi_currency'`,
    );
    await flagService.invalidate();

    const res = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${campaignWithRouting}/checkout-config`,
    });

    expect(res.statusCode).toBe(404);

    // Re-enable
    await db.execute(
      sql`UPDATE feature_flags SET enabled = TRUE WHERE key = 'donation.multi_currency'`,
    );
    await flagService.invalidate();
  });

  it("returns 404 when campaign does not exist", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${NON_EXISTENT_CAMPAIGN_ID}/checkout-config`,
    });

    expect(res.statusCode).toBe(404);
    const body = res.json<{ title: string }>();
    expect(body.title).toMatch(/campaign_not_found|not.?found/i);
  });

  it("returns 422 campaign_not_ready_for_online_payment when no online-default fund", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${campaignWithNoRouting}/checkout-config`,
    });

    expect(res.statusCode).toBe(422);
    const body = res.json<{ title: string }>();
    expect(body.title).toMatch(/campaign_not_ready_for_online_payment/i);
  });

  it("returns 200 with settlementCurrency and presentmentCurrencies when fully configured", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${campaignWithRouting}/checkout-config`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: { settlementCurrency: string; presentmentCurrencies: string[] };
    }>();
    expect(body.data.settlementCurrency).toBe("CHF");
    // At minimum the settlement currency itself should be in the list
    expect(body.data.presentmentCurrencies).toContain("CHF");
  });

  it("is a public endpoint — no auth required", async () => {
    // No authorization header — should still get 200 (or 422 if campaign not ready)
    const res = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${campaignWithRouting}/checkout-config`,
      // No headers — deliberately unauthenticated
    });

    // Not a 401 — public endpoint
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).toBe(200);
  });
});
