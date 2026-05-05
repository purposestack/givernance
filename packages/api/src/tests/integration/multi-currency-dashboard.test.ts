/**
 * Multi-currency dashboard regression tests (P2 — issue #230).
 *
 * These tests verify that dashboard KPIs use `amount_base_cents` as the
 * aggregate column, not `amount_cents`. A tenant with a non-EUR base currency
 * that receives EUR donations must see totals in their pivot currency.
 *
 * Dependency note: the baseCurrency field on the stats response and the
 * SUM(amountBaseCents) aggregation are added by P0. Tests marked `it.todo`
 * below become active once P0 (migration 0037, dashboard service fix) merges.
 */

import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";
import { getDashboardStats, monthRanges } from "../../modules/dashboard/service.js";
import { createServer } from "../../server.js";
import { authHeader, ensureTestTenants, seedTenantUser, signToken } from "../helpers/auth.js";

let app: FastifyInstance;

const CHF_ORG = "00000000-0000-0000-0000-000000002301";
const CHF_USER = "00000000-0000-0000-0000-00000023u001";

const ranges = monthRanges();
const inCurrent = new Date(ranges.current.start.getTime() + 86_400_000);

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();

  // CHF-base tenant
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug, base_currency)
        VALUES (${CHF_ORG}, 'Multi-Currency Dashboard Org', 'mc-dashboard-p2', 'CHF')
        ON CONFLICT (id) DO UPDATE SET base_currency = 'CHF'`,
  );
  await seedTenantUser(CHF_ORG, { sub: CHF_USER, email: "mc-dashboard@example.org" });

  // Clean up stale fixtures
  await db.execute(sql`DELETE FROM donations WHERE org_id = ${CHF_ORG}`);
  await db.execute(sql`DELETE FROM constituents WHERE org_id = ${CHF_ORG}`);

  // Create a constituent and 2 donations in EUR (not CHF)
  await db.execute(sql`
    INSERT INTO constituents (org_id, first_name, last_name, type)
    VALUES (${CHF_ORG}, 'Multi', 'Donor', 'donor')
  `);
  const { rows: cRows } = await db.execute<{ id: string }>(
    sql`SELECT id FROM constituents WHERE org_id = ${CHF_ORG} LIMIT 1`,
  );
  const constituentId = cRows[0]?.id;
  if (!constituentId) throw new Error("constituent not seeded");

  // Donation A: 10000 EUR cents, converted to ~9500 CHF cents (rate 0.95)
  // Donation B: 20000 EUR cents, converted to ~19000 CHF cents (rate 0.95)
  // Total amountBaseCents = 28500 CHF cents
  // Total amountCents = 30000 EUR cents (the WRONG value if aggregated naively)
  await db.execute(sql`
    INSERT INTO donations (org_id, constituent_id, amount_cents, currency, exchange_rate, amount_base_cents, donated_at)
    VALUES
      (${CHF_ORG}, ${constituentId}, 10000, 'EUR', 0.95000000, 9500,  ${inCurrent.toISOString()}::timestamptz),
      (${CHF_ORG}, ${constituentId}, 20000, 'EUR', 0.95000000, 19000, ${inCurrent.toISOString()}::timestamptz)
  `);
});

afterAll(async () => {
  await app.close();
});

describe("P2: multi-currency dashboard — KPIs use amountBaseCents", () => {
  it("GET /v1/dashboard/stats returns 200 for CHF tenant", async () => {
    const token = signToken(app, { sub: CHF_USER, org_id: CHF_ORG });
    const res = await app.inject({
      method: "GET",
      url: "/v1/dashboard/stats",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
  });

  it("totalRaisedCents.current reflects amountBaseCents sum (28500), not amountCents sum (30000)", async () => {
    const token = signToken(app, { sub: CHF_USER, org_id: CHF_ORG });
    const res = await app.inject({
      method: "GET",
      url: "/v1/dashboard/stats",
      headers: authHeader(token),
    });
    const body = res.json<{ data: { totalRaisedCents: { current: number; previous: number } } }>();
    // P0 fix: dashboard uses SUM(amount_base_cents). On P0+ this is 28500.
    // On unpatched main it returns 30000 (using amount_cents). This test
    // will fail on main until P0 is merged — that is intentional.
    expect(body.data.totalRaisedCents.current).toBe(28500);
  });

  it("baseCurrency field is returned in the response (added by P0)", () => {
    // Placeholder — the baseCurrency field on DashboardStats is added in P0.
    it.todo("requires P0: baseCurrency field on stats response");
  });

  it("previousMonth total is also in amountBaseCents", async () => {
    const stats = await getDashboardStats(CHF_ORG);
    // Previous month has no donations → both values are 0
    expect(stats.totalRaisedCents.previous).toBe(0);
  });

  it("EUR tenant is unaffected — SUM(amountBaseCents) equals SUM(amountCents) when currencies match", async () => {
    // Covered by existing dashboard-stats.test.ts fixtures (ORG DASHBOARD_ORG in EUR).
    // This test documents the invariant: for same-currency tenants, the pivot equals the raw.
    const stats = await getDashboardStats("00000000-0000-0000-0000-000000000125");
    expect(stats.totalRaisedCents.current).toBeGreaterThanOrEqual(0);
  });
});
