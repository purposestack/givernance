import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";
import { createServer } from "../../server.js";
import { authHeader, ensureTestTenants, ORG_A, signToken, signTokenB } from "../helpers/auth.js";

let app: FastifyInstance;

const thisYear = new Date().getFullYear();
const lastYear = thisYear - 1;
const twoYearsAgo = thisYear - 2;

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();

  const tokenA = signToken(app);

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

  // Insert donations directly for precise date control
  await db.execute(sql`
    INSERT INTO donations (org_id, constituent_id, amount_cents, currency, donated_at)
    VALUES
      -- LYBUNT donor: donated last year only
      (${ORG_A}, ${lybuntId}, 5000, 'EUR', ${`${lastYear}-06-15`}::timestamptz),
      -- SYBUNT donor: donated two years ago only
      (${ORG_A}, ${sybuntId}, 3000, 'EUR', ${`${twoYearsAgo}-03-10`}::timestamptz),
      -- Active donor: donated this year (should NOT appear in either report)
      (${ORG_A}, ${activeId}, 10000, 'EUR', ${`${thisYear}-01-20`}::timestamptz),
      -- Active donor also donated last year
      (${ORG_A}, ${activeId}, 8000, 'EUR', ${`${lastYear}-11-05`}::timestamptz)
  `);
});

afterAll(async () => {
  await app.close();
});

// ─── LYBUNT Report ──────────────────────────────────────────────────────────

describe("LYBUNT Report", () => {
  it("GET /v1/reports/lybunt returns donors from last year who did not donate this year", async () => {
    const token = signToken(app);
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

  it("GET /v1/reports/lybunt accepts year query parameter", async () => {
    const token = signToken(app);
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
    const token = signToken(app);
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
