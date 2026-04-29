import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";
import { getDashboardStats, monthRanges } from "../../modules/dashboard/service.js";
import { createServer } from "../../server.js";
import { authHeader, ensureTestTenants, seedTenantUser, signToken } from "../helpers/auth.js";

let app: FastifyInstance;
const DASHBOARD_ORG = "00000000-0000-0000-0000-000000000125";
const OTHER_ORG = "00000000-0000-0000-0000-000000000126";
const DASHBOARD_USER = "00000000-0000-0000-0000-0000000d0101";
const OTHER_USER = "00000000-0000-0000-0000-0000000d0102";

const ranges = monthRanges();
const inCurrent = new Date(ranges.current.start.getTime() + 86_400_000);
const inPrevious = new Date(ranges.previous.start.getTime() + 86_400_000);
const beforePrevious = new Date(ranges.previous.start.getTime() - 86_400_000);

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();

  for (const orgId of [DASHBOARD_ORG, OTHER_ORG]) {
    await db.execute(sql`DELETE FROM outbox_events WHERE tenant_id = ${orgId}`);
    await db.execute(sql`DELETE FROM donations WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM campaigns WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM constituents WHERE org_id = ${orgId}`);
    await db.execute(
      sql`INSERT INTO tenants (id, name, slug, base_currency)
          VALUES (${orgId}, 'Dashboard Org', ${`dashboard-${orgId.slice(-3)}`}, 'EUR')
          ON CONFLICT (id) DO UPDATE SET base_currency = 'EUR'`,
    );
  }
  // Distinct subs so seedTenantUser's derived rowId doesn't collide
  // (it slices the orgId — orgs sharing a tail would overwrite each other).
  await seedTenantUser(DASHBOARD_ORG, { sub: DASHBOARD_USER, email: "dashboard@example.org" });
  await seedTenantUser(OTHER_ORG, { sub: OTHER_USER, email: "other@example.org" });

  // DASHBOARD_ORG fixtures — known counts/sums per period
  // Donors: 2 in current, 3 in previous, 1 before (must NOT be counted)
  await db.execute(sql`
    INSERT INTO constituents (org_id, first_name, last_name, type, created_at, updated_at)
    VALUES
      (${DASHBOARD_ORG}, 'D1', 'Cur', 'donor', ${inCurrent.toISOString()}, ${inCurrent.toISOString()}),
      (${DASHBOARD_ORG}, 'D2', 'Cur', 'donor', ${inCurrent.toISOString()}, ${inCurrent.toISOString()}),
      (${DASHBOARD_ORG}, 'D3', 'Prev', 'donor', ${inPrevious.toISOString()}, ${inPrevious.toISOString()}),
      (${DASHBOARD_ORG}, 'D4', 'Prev', 'donor', ${inPrevious.toISOString()}, ${inPrevious.toISOString()}),
      (${DASHBOARD_ORG}, 'D5', 'Prev', 'donor', ${inPrevious.toISOString()}, ${inPrevious.toISOString()}),
      (${DASHBOARD_ORG}, 'D6', 'Old', 'donor', ${beforePrevious.toISOString()}, ${beforePrevious.toISOString()}),
      (${DASHBOARD_ORG}, 'V1', 'Vol', 'volunteer', ${inCurrent.toISOString()}, ${inCurrent.toISOString()})
  `);

  // Pick one constituent for donation FK
  const { rows: donorRows } = await db.execute<{ id: string }>(
    sql`SELECT id FROM constituents WHERE org_id = ${DASHBOARD_ORG} AND first_name = 'D1' LIMIT 1`,
  );
  const donorId = donorRows[0]?.id;
  if (!donorId) throw new Error("Test setup: D1 donor not found");

  // Donations: 12000 cents total in current (5000 + 7000), 3000 in previous, 999 before
  await db.execute(sql`
    INSERT INTO donations (
      org_id, constituent_id, amount_cents, currency, exchange_rate, amount_base_cents, donated_at
    )
    VALUES
      (${DASHBOARD_ORG}, ${donorId}, 5000, 'EUR', 1.00000000, 5000, ${inCurrent.toISOString()}::timestamptz),
      (${DASHBOARD_ORG}, ${donorId}, 7000, 'EUR', 1.00000000, 7000, ${inCurrent.toISOString()}::timestamptz),
      (${DASHBOARD_ORG}, ${donorId}, 3000, 'EUR', 1.00000000, 3000, ${inPrevious.toISOString()}::timestamptz),
      (${DASHBOARD_ORG}, ${donorId}, 999, 'EUR', 1.00000000, 999, ${beforePrevious.toISOString()}::timestamptz)
  `);

  // Campaigns: 1 active in current, 2 active in previous, 1 draft in current (must NOT count)
  await db.execute(sql`
    INSERT INTO campaigns (org_id, name, type, status, default_currency, created_at, updated_at)
    VALUES
      (${DASHBOARD_ORG}, 'C-cur-active', 'digital', 'active', 'EUR', ${inCurrent.toISOString()}, ${inCurrent.toISOString()}),
      (${DASHBOARD_ORG}, 'C-cur-draft', 'digital', 'draft', 'EUR', ${inCurrent.toISOString()}, ${inCurrent.toISOString()}),
      (${DASHBOARD_ORG}, 'C-prev-1', 'digital', 'active', 'EUR', ${inPrevious.toISOString()}, ${inPrevious.toISOString()}),
      (${DASHBOARD_ORG}, 'C-prev-2', 'digital', 'active', 'EUR', ${inPrevious.toISOString()}, ${inPrevious.toISOString()})
  `);

  // OTHER_ORG fixture — must not leak into DASHBOARD_ORG totals
  await db.execute(sql`
    INSERT INTO constituents (org_id, first_name, last_name, type, created_at, updated_at)
    VALUES (${OTHER_ORG}, 'X1', 'Other', 'donor', ${inCurrent.toISOString()}, ${inCurrent.toISOString()})
  `);
});

afterAll(async () => {
  await app.close();
});

describe("Dashboard stats — service", () => {
  it("buckets donations, donors, and active campaigns by current/previous month", async () => {
    const stats = await getDashboardStats(DASHBOARD_ORG);
    expect(stats.totalRaisedCents).toEqual({ current: 12000, previous: 3000 });
    expect(stats.newDonors).toEqual({ current: 2, previous: 3 });
    expect(stats.newActiveCampaigns).toEqual({ current: 1, previous: 2 });
  });

  it("isolates tenants — OTHER_ORG donor does not show up in DASHBOARD_ORG stats", async () => {
    const stats = await getDashboardStats(OTHER_ORG);
    expect(stats.totalRaisedCents).toEqual({ current: 0, previous: 0 });
    expect(stats.newDonors.current).toBe(1);
    expect(stats.newActiveCampaigns).toEqual({ current: 0, previous: 0 });
  });
});

describe("Dashboard stats — route", () => {
  it("GET /v1/dashboard/stats returns the same shape as the service", async () => {
    const token = signToken(app, { org_id: DASHBOARD_ORG, sub: DASHBOARD_USER });
    const res = await app.inject({
      method: "GET",
      url: "/v1/dashboard/stats",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        totalRaisedCents: { current: number; previous: number };
        newDonors: { current: number; previous: number };
        newActiveCampaigns: { current: number; previous: number };
      };
    }>();
    expect(body.data.totalRaisedCents).toEqual({ current: 12000, previous: 3000 });
    expect(body.data.newDonors).toEqual({ current: 2, previous: 3 });
    expect(body.data.newActiveCampaigns).toEqual({ current: 1, previous: 2 });
  });

  it("GET /v1/dashboard/stats without auth returns 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/dashboard/stats",
    });
    expect(res.statusCode).toBe(401);
  });

  it("GET /v1/dashboard/stats from another tenant returns that tenant's data", async () => {
    const token = signToken(app, { org_id: OTHER_ORG, sub: OTHER_USER });
    const res = await app.inject({
      method: "GET",
      url: "/v1/dashboard/stats",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: { totalRaisedCents: { current: number; previous: number } };
    }>();
    expect(body.data.totalRaisedCents).toEqual({ current: 0, previous: 0 });
  });
});
