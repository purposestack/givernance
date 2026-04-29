/**
 * Server-side sort across paginated list endpoints (issue #209).
 *
 * Locks two contracts per route:
 *   1. Unknown `sort` field → 400 with RFC 9457 problem detail body
 *      (per memory `lock_rfc9457_body_in_tests`: validate the body shape,
 *      not just the status code).
 *   2. `sort=name&order=asc` returns rows ordered server-side, so the
 *      first row of a `perPage=100` window is the alphabetic minimum —
 *      proves the orderBy reaches the DB and isn't applied client-side.
 *
 * The asc/desc smoke test is enough to detect a regression to fixed
 * orderBy. Per-route sort-field combinatorics (every column × asc/desc)
 * are intentionally NOT exercised — they'd add minutes to CI for the
 * same signal.
 */

import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";
import { createServer } from "../../server.js";
import { authHeader, ensureTestTenants, ORG_A, signToken } from "../helpers/auth.js";

const PROBLEM_TYPE_400 = /http-status\/400/;

let app: FastifyInstance;
let token: string;

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();
  token = signToken(app);

  // Clean slate so the asc/desc assertions on min/max names are
  // deterministic regardless of what previous suites left behind.
  // Order matters: child tables before parents to avoid FK violations
  // (`pledges` and `donations` both FK to `constituents`).
  await db.execute(sql`DELETE FROM donation_allocations WHERE org_id = ${ORG_A}`);
  await db.execute(sql`DELETE FROM donations WHERE org_id = ${ORG_A}`);
  await db.execute(sql`DELETE FROM pledges WHERE org_id = ${ORG_A}`);
  await db.execute(sql`DELETE FROM campaign_funds WHERE org_id = ${ORG_A}`);
  await db.execute(sql`DELETE FROM funds WHERE org_id = ${ORG_A}`);
  await db.execute(sql`DELETE FROM campaigns WHERE org_id = ${ORG_A}`);
  await db.execute(sql`DELETE FROM constituents WHERE org_id = ${ORG_A}`);

  // Seed three constituents whose lower(lastName) ordering is unambiguous
  // (Adams < Mitchell < Zane) regardless of locale collation defaults.
  for (const [first, last] of [
    ["Bea", "Mitchell"],
    ["Cara", "Adams"],
    ["Dan", "Zane"],
  ]) {
    await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(token),
      payload: { firstName: first, lastName: last, type: "donor" },
    });
  }

  // Seed three campaigns and three funds with similarly disjoint names.
  for (const name of ["Beta Drive", "Alpha Push", "Zeta Finale"]) {
    await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: authHeader(token),
      payload: { name, type: "digital" },
    });
  }
  for (const name of ["Beta Reserve", "Alpha Pool", "Zeta Endowment"]) {
    await app.inject({
      method: "POST",
      url: "/v1/funds",
      headers: authHeader(token),
      payload: { name, type: "unrestricted" },
    });
  }
});

afterAll(async () => {
  await app.close();
});

interface ProblemBody {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
}

function expectProblem400(body: ProblemBody) {
  // RFC 9457 — body MUST have at minimum a `type` and `status`. Lock the
  // shape (not just the code) so a regression to plain-string or
  // `{error: "..."}` body fails this test.
  expect(body.status).toBe(400);
  expect(body.type).toMatch(PROBLEM_TYPE_400);
  expect(body.title).toBeTruthy();
}

describe("GET /v1/donations — server-side sort", () => {
  it("rejects an unknown sort field with RFC 9457 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/donations?sort=ssrf_attempt",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(400);
    expectProblem400(res.json<ProblemBody>());
  });

  it("rejects an unknown order value with 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/donations?order=sideways",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(400);
    expectProblem400(res.json<ProblemBody>());
  });

  it("accepts a valid sort + order without erroring", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/donations?sort=amountCents&order=asc&perPage=100",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("GET /v1/constituents — server-side sort", () => {
  it("rejects an unknown sort field with RFC 9457 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents?sort=email", // not in the whitelist
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(400);
    expectProblem400(res.json<ProblemBody>());
  });

  it("sort=name&order=asc returns rows ordered by lower(lastName) ASC", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents?sort=name&order=asc&perPage=100",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ firstName: string; lastName: string }> }>();
    const lastNames = body.data.map((c) => c.lastName.toLowerCase());
    const sorted = [...lastNames].sort();
    expect(lastNames).toEqual(sorted);
    // Spot-check: with the seeded data, "adams" must come before "zane".
    expect(lastNames.indexOf("adams")).toBeLessThan(lastNames.indexOf("zane"));
  });

  it("sort=name&order=desc reverses the order", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents?sort=name&order=desc&perPage=100",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ lastName: string }> }>();
    const lastNames = body.data.map((c) => c.lastName.toLowerCase());
    expect(lastNames.indexOf("zane")).toBeLessThan(lastNames.indexOf("adams"));
  });
});

describe("GET /v1/campaigns — server-side sort", () => {
  it("rejects an unknown sort field with RFC 9457 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/campaigns?sort=raisedCents",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(400);
    expectProblem400(res.json<ProblemBody>());
  });

  it("sort=name&order=asc returns rows ordered alphabetically", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/campaigns?sort=name&order=asc&perPage=100",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ name: string }> }>();
    const names = body.data.map((c) => c.name.toLowerCase());
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });
});

describe("GET /v1/funds — server-side sort", () => {
  it("rejects an unknown sort field with RFC 9457 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/funds?sort=balanceCents",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(400);
    expectProblem400(res.json<ProblemBody>());
  });

  it("sort=name&order=asc returns rows ordered alphabetically", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/funds?sort=name&order=asc&perPage=100",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ name: string }> }>();
    const names = body.data.map((c) => c.name.toLowerCase());
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });
});
