import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";
import { createServer } from "../../server.js";
import { authHeader, ensureTestTenants, signToken, signTokenB } from "../helpers/auth.js";

let app: FastifyInstance;
const REPORTS_ORG = "00000000-0000-0000-0000-000000000124";

const thisYear = new Date().getFullYear();
const lastYear = thisYear - 1;
const twoYearsAgo = thisYear - 2;
const threeYearsAgo = thisYear - 3;

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();
  await db.execute(sql`DELETE FROM outbox_events WHERE tenant_id = ${REPORTS_ORG}`);
  await db.execute(sql`DELETE FROM donations WHERE org_id = ${REPORTS_ORG}`);
  await db.execute(sql`DELETE FROM constituents WHERE org_id = ${REPORTS_ORG}`);
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug, base_currency)
        VALUES (${REPORTS_ORG}, 'Reports Org', 'reports-org', 'CHF')
        ON CONFLICT (id) DO UPDATE SET base_currency = 'CHF'`,
  );

  const tokenA = signToken(app, { org_id: REPORTS_ORG });

  // Create constituents for lifecycle tests
  const lybuntRes = await app.inject({
    method: "POST",
    url: "/v1/constituents?force=true",
    headers: authHeader(tokenA),
    payload: { firstName: "Lybunt", lastName: "Donor", type: "donor" },
  });
  const lybuntId = lybuntRes.json<{ data: { id: string } }>().data.id;

  const sybuntRes = await app.inject({
    method: "POST",
    url: "/v1/constituents?force=true",
    headers: authHeader(tokenA),
    payload: { firstName: "Sybunt", lastName: "Donor", type: "donor" },
  });
  const sybuntId = sybuntRes.json<{ data: { id: string } }>().data.id;

  const activeRes = await app.inject({
    method: "POST",
    url: "/v1/constituents?force=true",
    headers: authHeader(tokenA),
    payload: { firstName: "Active", lastName: "Donor", type: "donor" },
  });
  const activeId = activeRes.json<{ data: { id: string } }>().data.id;

  // Multi-year donor: donated last year AND two years ago (LYBUNT with multiple past years)
  const multiYearRes = await app.inject({
    method: "POST",
    url: "/v1/constituents?force=true",
    headers: authHeader(tokenA),
    payload: { firstName: "MultiYear", lastName: "Donor", type: "donor" },
  });
  const multiYearId = multiYearRes.json<{ data: { id: string } }>().data.id;

  // Ancient-only donor: donated 3+ years ago only (SYBUNT boundary)
  const ancientRes = await app.inject({
    method: "POST",
    url: "/v1/constituents?force=true",
    headers: authHeader(tokenA),
    payload: { firstName: "Ancient", lastName: "Donor", type: "donor" },
  });
  const ancientId = ancientRes.json<{ data: { id: string } }>().data.id;

  // Insert donations directly for precise date control
  await db.execute(sql`
    INSERT INTO donations (
      org_id,
      constituent_id,
      amount_cents,
      currency,
      exchange_rate,
      amount_base_cents,
      donated_at
    )
    VALUES
      -- LYBUNT donor: donated last year only
      (${REPORTS_ORG}, ${lybuntId}, 5000, 'EUR', 0.98000000, 4900, ${`${lastYear}-06-15`}::timestamptz),
      -- SYBUNT donor: donated two years ago only
      (${REPORTS_ORG}, ${sybuntId}, 3000, 'EUR', 0.93333333, 2800, ${`${twoYearsAgo}-03-10`}::timestamptz),
      -- Active donor: donated this year (should NOT appear in either report)
      (${REPORTS_ORG}, ${activeId}, 10000, 'EUR', 0.97000000, 9700, ${`${thisYear}-01-20`}::timestamptz),
      -- Active donor also donated last year
      (${REPORTS_ORG}, ${activeId}, 8000, 'EUR', 0.97500000, 7800, ${`${lastYear}-11-05`}::timestamptz),
      -- MultiYear donor: donated last year + two years ago (LYBUNT, total = 12000)
      (${REPORTS_ORG}, ${multiYearId}, 7000, 'EUR', 0.97142857, 6800, ${`${lastYear}-04-01`}::timestamptz),
      (${REPORTS_ORG}, ${multiYearId}, 5000, 'EUR', 0.94000000, 4700, ${`${twoYearsAgo}-09-20`}::timestamptz),
      -- Ancient donor: donated 3 years ago only (SYBUNT boundary, total = 2500)
      (${REPORTS_ORG}, ${ancientId}, 2500, 'EUR', 0.96000000, 2400, ${`${threeYearsAgo}-12-01`}::timestamptz)
  `);
});

afterAll(async () => {
  await app.close();
});

// ─── LYBUNT Report ──────────────────────────────────────────────────────────

describe("LYBUNT Report", () => {
  it("GET /v1/reports/lybunt returns donors from last year who did not donate this year", async () => {
    const token = signToken(app, { org_id: REPORTS_ORG });
    const res = await app.inject({
      method: "GET",
      url: "/v1/reports/lybunt",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { firstName: string; totalDonatedCents: number }[] }>();
    const names = body.data.map((d) => d.firstName);
    expect(names).toContain("Lybunt");
    expect(names).not.toContain("Active");
    expect(names).not.toContain("Sybunt");
  });

  it("includes multi-year donor with correct totalDonatedCents (last year donations only)", async () => {
    const token = signToken(app, { org_id: REPORTS_ORG });
    const res = await app.inject({
      method: "GET",
      url: "/v1/reports/lybunt",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { firstName: string; totalDonatedCents: number }[] }>();
    const multiYear = body.data.find((d) => d.firstName === "MultiYear");
    expect(multiYear).toBeDefined();
    expect(multiYear?.totalDonatedCents).toBe(6800);
  });

  it("does not include ancient-only donor (no last year donations)", async () => {
    const token = signToken(app, { org_id: REPORTS_ORG });
    const res = await app.inject({
      method: "GET",
      url: "/v1/reports/lybunt",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { firstName: string }[] }>();
    const names = body.data.map((d) => d.firstName);
    expect(names).not.toContain("Ancient");
  });

  it("Lybunt donor totalDonatedCents is correct", async () => {
    const token = signToken(app, { org_id: REPORTS_ORG });
    const res = await app.inject({
      method: "GET",
      url: "/v1/reports/lybunt",
      headers: authHeader(token),
    });

    const body = res.json<{ data: { firstName: string; totalDonatedCents: number }[] }>();
    const lybunt = body.data.find((d) => d.firstName === "Lybunt");
    expect(lybunt).toBeDefined();
    expect(lybunt?.totalDonatedCents).toBe(4900);
  });

  it("GET /v1/reports/lybunt accepts year query parameter", async () => {
    const token = signToken(app, { org_id: REPORTS_ORG });
    const res = await app.inject({
      method: "GET",
      url: `/v1/reports/lybunt?year=${lastYear}`,
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { firstName: string }[] }>();
    const names = body.data.map((d) => d.firstName);
    // When year=lastYear, LYBUNT looks at twoYearsAgo → Sybunt donor should appear
    expect(names).toContain("Sybunt");
  });

  it("GET /v1/reports/lybunt without auth returns 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/reports/lybunt",
    });

    expect(res.statusCode).toBe(401);
  });
});

// ─── SYBUNT Report ──────────────────────────────────────────────────────────

describe("SYBUNT Report", () => {
  it("GET /v1/reports/sybunt returns donors from any past year who did not donate this year", async () => {
    const token = signToken(app, { org_id: REPORTS_ORG });
    const res = await app.inject({
      method: "GET",
      url: "/v1/reports/sybunt",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { firstName: string; totalDonatedCents: number }[] }>();
    const names = body.data.map((d) => d.firstName);
    expect(names).toContain("Lybunt");
    expect(names).toContain("Sybunt");
    expect(names).not.toContain("Active");
  });

  it("includes ancient-only donor (SYBUNT boundary — 3+ years ago)", async () => {
    const token = signToken(app, { org_id: REPORTS_ORG });
    const res = await app.inject({
      method: "GET",
      url: "/v1/reports/sybunt",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { firstName: string; totalDonatedCents: number }[] }>();
    const ancient = body.data.find((d) => d.firstName === "Ancient");
    expect(ancient).toBeDefined();
    expect(ancient?.totalDonatedCents).toBe(2400);
  });

  it("multi-year donor totalDonatedCents aggregates all past donations", async () => {
    const token = signToken(app, { org_id: REPORTS_ORG });
    const res = await app.inject({
      method: "GET",
      url: "/v1/reports/sybunt",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { firstName: string; totalDonatedCents: number }[] }>();
    const multiYear = body.data.find((d) => d.firstName === "MultiYear");
    expect(multiYear).toBeDefined();
    expect(multiYear?.totalDonatedCents).toBe(11500);
  });

  it("Sybunt donor totalDonatedCents is correct", async () => {
    const token = signToken(app, { org_id: REPORTS_ORG });
    const res = await app.inject({
      method: "GET",
      url: "/v1/reports/sybunt",
      headers: authHeader(token),
    });

    const body = res.json<{ data: { firstName: string; totalDonatedCents: number }[] }>();
    const sybunt = body.data.find((d) => d.firstName === "Sybunt");
    expect(sybunt).toBeDefined();
    expect(sybunt?.totalDonatedCents).toBe(2800);
  });

  it("GET /v1/reports/sybunt without auth returns 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/reports/sybunt",
    });

    expect(res.statusCode).toBe(401);
  });
});

// ─── Reports RLS Tenant Isolation ──────────────────────────────────────────

describe("Reports RLS tenant isolation", () => {
  it("Tenant B LYBUNT report does not include Tenant A donors", async () => {
    const tokenB = signTokenB(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/reports/lybunt",
      headers: authHeader(tokenB),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { firstName: string }[] }>();
    const names = body.data.map((d) => d.firstName);
    expect(names).not.toContain("Lybunt");
  });

  it("Tenant B SYBUNT report does not include Tenant A donors", async () => {
    const tokenB = signTokenB(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/reports/sybunt",
      headers: authHeader(tokenB),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { firstName: string }[] }>();
    const names = body.data.map((d) => d.firstName);
    expect(names).not.toContain("Sybunt");
    expect(names).not.toContain("Lybunt");
  });
});

// ─── PII Export Audit Trail ──────────────────────────────────────────────────

describe("PII export audit trail", () => {
  it("reports.lybunt_exported outbox event is emitted on GET /v1/reports/lybunt", async () => {
    const token = signToken(app, { org_id: REPORTS_ORG });
    await app.inject({
      method: "GET",
      url: "/v1/reports/lybunt",
      headers: authHeader(token),
    });

    const rows = await db.execute(
      sql`SELECT type, payload FROM outbox_events
          WHERE tenant_id = ${REPORTS_ORG} AND type = 'reports.lybunt_exported'
          ORDER BY created_at DESC LIMIT 1`,
    );

    expect(rows.rows.length).toBe(1);
    expect((rows.rows[0] as { type: string }).type).toBe("reports.lybunt_exported");
    const payload = (rows.rows[0] as { payload: { year: number; resultCount: number } }).payload;
    expect(payload.year).toBe(thisYear);
    expect(typeof payload.resultCount).toBe("number");
  });

  it("reports.sybunt_exported outbox event is emitted on GET /v1/reports/sybunt", async () => {
    const token = signToken(app, { org_id: REPORTS_ORG });
    await app.inject({
      method: "GET",
      url: "/v1/reports/sybunt",
      headers: authHeader(token),
    });

    const rows = await db.execute(
      sql`SELECT type, payload FROM outbox_events
          WHERE tenant_id = ${REPORTS_ORG} AND type = 'reports.sybunt_exported'
          ORDER BY created_at DESC LIMIT 1`,
    );

    expect(rows.rows.length).toBe(1);
    expect((rows.rows[0] as { type: string }).type).toBe("reports.sybunt_exported");
    const payload = (rows.rows[0] as { payload: { year: number; resultCount: number } }).payload;
    expect(payload.year).toBe(thisYear);
    expect(typeof payload.resultCount).toBe("number");
  });
});

// ─── Reports RBAC (wrong role) ──────────────────────────────────────────────

describe("Reports RBAC — non-admin forbidden", () => {
  it("GET /v1/reports/lybunt with viewer role returns 403", async () => {
    const token = signToken(app, { org_id: REPORTS_ORG, role: "viewer" });
    const res = await app.inject({
      method: "GET",
      url: "/v1/reports/lybunt",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(403);
  });

  it("GET /v1/reports/sybunt with user role returns 403", async () => {
    const token = signToken(app, { org_id: REPORTS_ORG, role: "user" });
    const res = await app.inject({
      method: "GET",
      url: "/v1/reports/sybunt",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(403);
  });
});
