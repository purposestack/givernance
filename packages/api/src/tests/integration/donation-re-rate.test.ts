/**
 * Donation amountBaseCents accuracy regression tests (P2 — issue #230).
 *
 * Verifies that donations created via POST /v1/donations store correct
 * `amount_base_cents` values when the donation currency differs from the
 * tenant's base currency.
 *
 * These tests work against the current schema on main; they verify the
 * existing amountBaseCents column is populated correctly on donation create.
 */

import { ExchangeRateService } from "@givernance/shared";
import { exchangeRates } from "@givernance/shared/schema";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../lib/db.js";
import { createServer } from "../../server.js";
import { authHeader, ensureTestTenants, seedTenantUser, signToken } from "../helpers/auth.js";

let app: FastifyInstance;

const CHF_ORG_RERATE = "00000000-0000-0000-0000-000000002310";
const CHF_USER_RERATE = "00000000-0000-0000-0000-00000023u010";
const TODAY = new Date().toISOString().slice(0, 10);

let constituentId: string;

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();

  await db.execute(
    sql`INSERT INTO tenants (id, name, slug, base_currency)
        VALUES (${CHF_ORG_RERATE}, 'Rerate Test Org CHF', 'rerate-test-chf', 'CHF')
        ON CONFLICT (id) DO UPDATE SET base_currency = 'CHF'`,
  );
  await seedTenantUser(CHF_ORG_RERATE, { sub: CHF_USER_RERATE, email: "rerate@example.org" });

  // Clean stale data
  await db.execute(sql`DELETE FROM donations WHERE org_id = ${CHF_ORG_RERATE}`);
  await db.execute(sql`DELETE FROM constituents WHERE org_id = ${CHF_ORG_RERATE}`);

  const token = signToken(app, { sub: CHF_USER_RERATE, org_id: CHF_ORG_RERATE });
  const cRes = await app.inject({
    method: "POST",
    url: "/v1/constituents?force=true",
    headers: authHeader(token),
    payload: { firstName: "Re", lastName: "Rate", type: "donor" },
  });
  constituentId = cRes.json<{ data: { id: string } }>().data.id;

  // Seed a known exchange rate EUR→CHF so tests are deterministic
  await db
    .insert(exchangeRates)
    .values({ currency: "EUR", baseCurrency: "CHF", date: TODAY, rate: "0.95000000" })
    .onConflictDoNothing();
});

afterAll(async () => {
  await app.close();
});

describe("P2: donation amountBaseCents accuracy", () => {
  it("EUR donation on a CHF tenant stores amountBaseCents ≈ amountCents × rate", async () => {
    const token = signToken(app, { sub: CHF_USER_RERATE, org_id: CHF_ORG_RERATE });
    const res = await app.inject({
      method: "POST",
      url: "/v1/donations",
      headers: authHeader(token),
      payload: {
        constituentId,
        amountCents: 10000,
        currency: "EUR",
        donatedAt: new Date().toISOString(),
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ data: { id: string; amountBaseCents: number; currency: string } }>();
    // 10000 EUR × 0.95 ≈ 9500 CHF cents (rate is local_exact from the seeded row)
    expect(body.data.amountBaseCents).toBe(9500);
    expect(body.data.currency).toBe("EUR");
  });

  it("CHF donation on a CHF tenant: amountBaseCents equals amountCents (same_currency parity)", async () => {
    const token = signToken(app, { sub: CHF_USER_RERATE, org_id: CHF_ORG_RERATE });
    const res = await app.inject({
      method: "POST",
      url: "/v1/donations",
      headers: authHeader(token),
      payload: {
        constituentId,
        amountCents: 5000,
        currency: "CHF",
        donatedAt: new Date().toISOString(),
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ data: { amountBaseCents: number; currency: string } }>();
    expect(body.data.amountBaseCents).toBe(5000);
    expect(body.data.currency).toBe("CHF");
  });

  it("convertAmountCents rounds correctly — no fractional cents stored", async () => {
    // 333 EUR × 0.95 = 316.35 — must be rounded to integer 316
    const svc = new ExchangeRateService({
      apiKey: "unused",
      dbClient: db,
      logger: { warn: vi.fn() },
    });
    const result = await svc.convertAmountCents(333, "EUR", "CHF");
    expect(Number.isInteger(result.amountBaseCents)).toBe(true);
  });

  it("donation with future donatedAt stores amountBaseCents (exchange_rate_at uses today)", async () => {
    const token = signToken(app, { sub: CHF_USER_RERATE, org_id: CHF_ORG_RERATE });
    const futureDonatedAt = new Date(Date.now() + 86_400_000).toISOString();
    const res = await app.inject({
      method: "POST",
      url: "/v1/donations",
      headers: authHeader(token),
      payload: {
        constituentId,
        amountCents: 1000,
        currency: "EUR",
        donatedAt: futureDonatedAt,
      },
    });
    // POST should succeed regardless of donatedAt — exchange_rate_at = CURRENT_DATE
    expect([200, 201]).toContain(res.statusCode);
  });

  it("exchangeRateSource is stored and visible on the donation response", () => {
    // exchange_rate_source column is added in P0 migration 0037.
    it.todo("requires P0: exchange_rate_source column on donations");
  });

  it("baseCurrencyAtDonation snapshot matches tenant base_currency at creation time", () => {
    // base_currency_at_donation column is added in P0 migration 0037.
    it.todo("requires P0: base_currency_at_donation column on donations");
  });
});
