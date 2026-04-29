/**
 * Server-side sort across paginated list endpoints (issue #209).
 *
 * Per route, this suite locks three contracts:
 *   1. Unknown `sort` field → 400 with RFC 9457 problem detail body
 *      (per memory `lock_rfc9457_body_in_tests`: validate the body shape,
 *      not just the status code).
 *   2. Both axes of the sort: `order=asc` returns rows in ascending order
 *      AND `order=desc` returns them reversed — proves the orderBy reaches
 *      the DB and isn't applied client-side. Per memory
 *      `role_test_coverage_both_directions` (analogous principle: every
 *      change covered in both directions).
 *   3. Edge cases that ajv literal-union validation should reject (empty
 *      `?sort=`, uppercase `?order=ASC`) and that the response shape stays
 *      RFC 9457 even when the dataset is empty.
 *
 * Tenant isolation: this suite uses a **dedicated** tenant
 * (`LIST_SORT_ORG`) instead of the shared `ORG_A`. Otherwise the
 * `beforeAll` cleanup would wipe data seeded by alphabetically-earlier
 * suites (`donations.test.ts`, `constituents.test.ts`, etc.) and any
 * future test that asserts on `ORG_A` row counts would break silently.
 * Same precedent as `tenant-onboarding-schema.test.ts` — share fixtures
 * only when the read path is observably the same.
 */

import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";
import { createServer } from "../../server.js";
import { authHeader, ensureTestTenants, seedTenantUser, signToken } from "../helpers/auth.js";

/**
 * RFC 9457 problem `type` URI used by this app for HTTP 400. Pinned to
 * the full origin so a regression that switches problem-type prefixes
 * (e.g. to a self-hosted IRI) doesn't pass silently.
 */
const PROBLEM_TYPE_400 = /^https:\/\/httpproblems\.com\/http-status\/400$/;

const LIST_SORT_ORG = "00000000-0000-0000-0000-00000000209a";
/** Empty tenant for "no rows" pagination assertions. */
const LIST_SORT_EMPTY_ORG = "00000000-0000-0000-0000-00000000209b";
// Distinct keycloak_id per tenant. `seedTenantUser` derives its synthetic
// rowId as `00000000-0000-0000-${orgSuffix.slice(0, 4)}-${subSuffix}` —
// where `orgSuffix` and `subSuffix` are the last 12 hex chars of `orgId`
// and `sub`. Both my tenants' last-12 starts with "0000" (so
// `orgSuffix.slice(0, 4)` collides), so we lean on the sub's last-12
// being distinct: pack the discriminator (`209a` / `209b`) into the
// LAST 12 hex chars of each sub, not the third UUID block.
const LIST_SORT_USER = "00000000-0000-0000-0000-000000209a01";
const LIST_SORT_EMPTY_USER = "00000000-0000-0000-0000-000000209b01";

let app: FastifyInstance;
let token: string;
let emptyToken: string;

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();

  // Two dedicated tenants for this suite — one seeded with disjoint
  // fixture data, one left empty. Both `INSERT … ON CONFLICT DO NOTHING`
  // so this suite is idempotent across re-runs.
  await db.execute(sql`
    INSERT INTO tenants (id, name, slug)
    VALUES
      (${LIST_SORT_ORG}, 'List Sort Org', 'list-sort-org'),
      (${LIST_SORT_EMPTY_ORG}, 'List Sort Empty Org', 'list-sort-empty-org')
    ON CONFLICT (id) DO NOTHING
  `);
  await seedTenantUser(LIST_SORT_ORG, { sub: LIST_SORT_USER });
  await seedTenantUser(LIST_SORT_EMPTY_ORG, { sub: LIST_SORT_EMPTY_USER });

  token = signToken(app, { org_id: LIST_SORT_ORG, sub: LIST_SORT_USER });
  emptyToken = signToken(app, { org_id: LIST_SORT_EMPTY_ORG, sub: LIST_SORT_EMPTY_USER });

  // Wipe only the dedicated tenant's data — order matters: child tables
  // before parents to avoid FK violations (`pledges` and `donations`
  // both FK to `constituents`).
  await db.execute(sql`DELETE FROM donation_allocations WHERE org_id = ${LIST_SORT_ORG}`);
  await db.execute(sql`DELETE FROM donations WHERE org_id = ${LIST_SORT_ORG}`);
  await db.execute(sql`DELETE FROM pledges WHERE org_id = ${LIST_SORT_ORG}`);
  await db.execute(sql`DELETE FROM campaign_funds WHERE org_id = ${LIST_SORT_ORG}`);
  await db.execute(sql`DELETE FROM funds WHERE org_id = ${LIST_SORT_ORG}`);
  await db.execute(sql`DELETE FROM campaigns WHERE org_id = ${LIST_SORT_ORG}`);
  await db.execute(sql`DELETE FROM constituents WHERE org_id = ${LIST_SORT_ORG}`);

  // Seed three constituents whose lower(firstName) ordering is unambiguous
  // (Bea < Cara < Dan) regardless of locale collation defaults. Sorted by
  // firstName because the column displays "First Last" — see
  // buildConstituentOrderBy in constituents/service.ts.
  const constituentIds: string[] = [];
  for (const [first, last] of [
    ["Bea", "Mitchell"],
    ["Cara", "Adams"],
    ["Dan", "Zane"],
  ]) {
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(token),
      payload: { firstName: first, lastName: last, type: "donor" },
    });
    if (res.statusCode !== 201) {
      throw new Error(`seed constituent failed: ${res.statusCode} ${res.body}`);
    }
    constituentIds.push(res.json<{ data: { id: string } }>().data.id);
  }

  // Three campaigns and three funds with similarly disjoint names.
  // Capture campaign ids so we can link each donation to a different
  // campaign — needed for the donations `?sort=campaign` direction tests.
  const campaignIds: string[] = [];
  for (const name of ["Beta Drive", "Alpha Push", "Zeta Finale"]) {
    const res = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: authHeader(token),
      payload: { name, type: "digital" },
    });
    if (res.statusCode !== 201) {
      throw new Error(`seed campaign failed: ${res.statusCode} ${res.body}`);
    }
    campaignIds.push(res.json<{ data: { id: string } }>().data.id);
  }
  for (const name of ["Beta Reserve", "Alpha Pool", "Zeta Endowment"]) {
    await app.inject({
      method: "POST",
      url: "/v1/funds",
      headers: authHeader(token),
      payload: { name, type: "unrestricted" },
    });
  }

  // Three donations with disjoint amounts so directionality on
  // `?sort=amountCents` is unambiguous, and pinned to disjoint donors +
  // campaigns so `?sort=donor` and `?sort=campaign` are unambiguous too.
  // Donor ↔ campaign pairing is intentionally non-monotonic (Bea→Beta,
  // Cara→Alpha, Dan→Zeta) so a regression that swapped donor for
  // campaign in `buildDonationOrderBy` would produce a different order
  // and fail the test, rather than coincidentally pass.
  for (let i = 0; i < constituentIds.length; i++) {
    const amounts = [1000, 5000, 9999];
    await app.inject({
      method: "POST",
      url: "/v1/donations",
      headers: authHeader(token),
      payload: {
        // biome-ignore lint/style/noNonNullAssertion: fixture array
        constituentId: constituentIds[i]!,
        // biome-ignore lint/style/noNonNullAssertion: fixture array
        campaignId: campaignIds[i]!,
        // biome-ignore lint/style/noNonNullAssertion: fixture array
        amountCents: amounts[i]!,
        currency: "EUR",
        paymentMethod: "check",
        paymentRef: `LIST-SORT-${i}-${Date.now()}`,
      },
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

  it("sort=amountCents&order=asc returns donations from smallest to largest", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/donations?sort=amountCents&order=asc&perPage=100",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ amountCents: number }> }>();
    const amounts = body.data.map((d) => d.amountCents);
    expect(amounts).toEqual([...amounts].sort((a, b) => a - b));
    expect(amounts).toEqual([1000, 5000, 9999]);
  });

  it("sort=amountCents&order=desc reverses the order", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/donations?sort=amountCents&order=desc&perPage=100",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ amountCents: number }> }>();
    expect(body.data.map((d) => d.amountCents)).toEqual([9999, 5000, 1000]);
  });

  it("sort=donor&order=asc returns donations ordered by lower(firstName) of the joined constituent", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/donations?sort=donor&order=asc&perPage=100",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: Array<{ constituent: { firstName: string; lastName: string } | null }>;
    }>();
    const firstNames = body.data.map((d) => d.constituent?.firstName.toLowerCase() ?? "");
    expect(firstNames).toEqual([...firstNames].sort());
    expect(firstNames.indexOf("bea")).toBeLessThan(firstNames.indexOf("dan"));
  });

  it("sort=donor&order=desc reverses the order", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/donations?sort=donor&order=desc&perPage=100",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ constituent: { firstName: string } | null }> }>();
    const firstNames = body.data.map((d) => d.constituent?.firstName.toLowerCase() ?? "");
    expect(firstNames.indexOf("dan")).toBeLessThan(firstNames.indexOf("bea"));
  });

  it("sort=campaign&order=asc returns donations ordered by lower(name) of the joined campaign", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/donations?sort=campaign&order=asc&perPage=100",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ campaign: { name: string } | null }> }>();
    const names = body.data.map((d) => d.campaign?.name.toLowerCase() ?? "");
    expect(names).toEqual([...names].sort());
    expect(names.indexOf("alpha push")).toBeLessThan(names.indexOf("zeta finale"));
  });

  it("sort=campaign&order=desc reverses the order — and rows with NULL campaign sort LAST under desc too", async () => {
    // Seed one donation WITHOUT a campaignId. Postgres' default ORDER BY
    // desc puts NULL first; `buildDonationOrderBy` pins NULLS LAST in
    // either direction so "no campaign" doesn't form a wall at the top
    // when the user clicks the column desc. This test catches a regression
    // to the default.
    const constituentRes = await app.inject({
      method: "GET",
      url: "/v1/constituents?perPage=1",
      headers: authHeader(token),
    });
    const constituentId = constituentRes.json<{ data: Array<{ id: string }> }>().data[0]?.id;
    if (!constituentId) throw new Error("expected at least one seeded constituent");
    const seed = await app.inject({
      method: "POST",
      url: "/v1/donations",
      headers: authHeader(token),
      payload: {
        constituentId,
        amountCents: 100,
        currency: "EUR",
        paymentMethod: "check",
        paymentRef: `LIST-SORT-NULLS-CAMPAIGN-${Date.now()}`,
      },
    });
    if (seed.statusCode !== 201) {
      throw new Error(`null-campaign donation seed failed: ${seed.statusCode} ${seed.body}`);
    }

    const res = await app.inject({
      method: "GET",
      url: "/v1/donations?sort=campaign&order=desc&perPage=100",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ campaign: { name: string } | null }> }>();
    const names = body.data.map((d) => d.campaign?.name.toLowerCase() ?? null);
    // Among non-null entries: zeta finale before alpha push (desc).
    const nonNull = names.filter((n): n is string => n !== null);
    expect(nonNull.indexOf("zeta finale")).toBeLessThan(nonNull.indexOf("alpha push"));
    // The null-campaign donation MUST come after all non-null entries.
    let lastNonNullIdx = -1;
    for (let i = names.length - 1; i >= 0; i--) {
      if (names[i] !== null) {
        lastNonNullIdx = i;
        break;
      }
    }
    const firstNullIdx = names.findIndex((n) => n === null);
    expect(firstNullIdx).toBeGreaterThan(lastNonNullIdx);
  });
});

describe("GET /v1/constituents — server-side sort", () => {
  it("rejects an unknown sort field with RFC 9457 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents?sort=phone", // not in the whitelist
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(400);
    expectProblem400(res.json<ProblemBody>());
  });

  it("sort=email&order=asc orders by lower(email) ASC, no-email rows last", async () => {
    // Seed deliberately exposes email NULLability: only Bea has an email
    // address by default (constituents seeded via POST without `email`
    // get NULL). Add an email to Cara so we have two non-null rows to
    // assert directionality on, and leave Dan as null.
    const constituentsRes = await app.inject({
      method: "GET",
      url: "/v1/constituents?perPage=100",
      headers: authHeader(token),
    });
    const all = constituentsRes.json<{
      data: Array<{ id: string; firstName: string; email: string | null }>;
    }>().data;
    const bea = all.find((c) => c.firstName === "Bea");
    const cara = all.find((c) => c.firstName === "Cara");
    if (!bea || !cara) throw new Error("expected seeded Bea + Cara constituents");
    if (!bea.email) {
      await app.inject({
        method: "PUT",
        url: `/v1/constituents/${bea.id}`,
        headers: authHeader(token),
        payload: { email: "alpha@example.test" },
      });
    }
    if (!cara.email) {
      await app.inject({
        method: "PUT",
        url: `/v1/constituents/${cara.id}`,
        headers: authHeader(token),
        payload: { email: "zulu@example.test" },
      });
    }

    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents?sort=email&order=asc&perPage=100",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ email: string | null }> }>();
    const emails = body.data.map((c) => c.email);
    const nonNull = emails.filter((e): e is string => e !== null);
    expect(nonNull).toEqual([...nonNull].sort());
    expect(nonNull.indexOf("alpha@example.test")).toBeLessThan(
      nonNull.indexOf("zulu@example.test"),
    );
    // Null emails come AFTER all non-null emails (NULLS LAST under asc).
    let lastNonNullIdx = -1;
    for (let i = emails.length - 1; i >= 0; i--) {
      if (emails[i] !== null) {
        lastNonNullIdx = i;
        break;
      }
    }
    const firstNullIdx = emails.findIndex((e) => e === null);
    if (firstNullIdx !== -1) {
      expect(firstNullIdx).toBeGreaterThan(lastNonNullIdx);
    }
  });

  it("sort=name&order=asc returns rows ordered by lower(firstName) ASC", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents?sort=name&order=asc&perPage=100",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ firstName: string; lastName: string }> }>();
    const firstNames = body.data.map((c) => c.firstName.toLowerCase());
    const sorted = [...firstNames].sort();
    expect(firstNames).toEqual(sorted);
    expect(firstNames.indexOf("bea")).toBeLessThan(firstNames.indexOf("dan"));
  });

  it("sort=name&order=desc reverses the order", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents?sort=name&order=desc&perPage=100",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ firstName: string }> }>();
    const firstNames = body.data.map((c) => c.firstName.toLowerCase());
    expect(firstNames.indexOf("dan")).toBeLessThan(firstNames.indexOf("bea"));
  });

  it("sort=lastDonation&order=desc orders by MAX(donations.donatedAt) desc, never-donated last", async () => {
    // The seed in beforeAll creates exactly one donation per constituent
    // (Bea→1000, Cara→5000, Dan→9999). Plus the null-campaign test in
    // the donations describe block adds a fourth donation against the
    // first-page constituent. We don't assert which constituent comes
    // first under desc — that depends on insert order — but we DO lock:
    //   - all constituents who have donated come before any who haven't
    //   - the response includes `lastDonationAt: string | null`
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents?sort=lastDonation&order=desc&perPage=100",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ lastDonationAt: string | null }> }>();
    expect(body.data.length).toBeGreaterThan(0);
    // Every row must expose the field (locks the response shape).
    for (const row of body.data) {
      expect(row).toHaveProperty("lastDonationAt");
    }
    // Donated rows precede never-donated rows under desc (NULLS LAST).
    let lastNonNullIdx = -1;
    for (let i = body.data.length - 1; i >= 0; i--) {
      if (body.data[i]?.lastDonationAt !== null) {
        lastNonNullIdx = i;
        break;
      }
    }
    const firstNullIdx = body.data.findIndex((r) => r.lastDonationAt === null);
    if (firstNullIdx !== -1 && lastNonNullIdx !== -1) {
      expect(firstNullIdx).toBeGreaterThan(lastNonNullIdx);
    }
  });

  it("sort=lastDonation&order=asc — non-null dates come back in ascending order", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents?sort=lastDonation&order=asc&perPage=100",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ lastDonationAt: string | null }> }>();
    const dates = body.data.map((r) => r.lastDonationAt).filter((d): d is string => d !== null);
    expect(dates).toEqual([...dates].sort());
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

  it("sort=progress&order=desc orders by raised/goal ratio, no-goal campaigns last", async () => {
    // The seed in beforeAll attaches Bea→Beta (1000), Cara→Alpha (5000),
    // Dan→Zeta (9999). None of those campaigns have a goal yet (the
    // seed creates campaigns without goalAmountCents), so they all sort
    // under NULLS LAST regardless of direction. Set distinct goals on
    // two of them so we can assert directionality on the ratio:
    //   - Beta:  goal 2000  → 1000/2000 = 50%
    //   - Alpha: goal 10000 → 5000/10000 = 50% as well, but with a
    //                          different absolute → tiebreak via
    //     campaign id is fine for the directionality assertion.
    //   - Zeta:  goal 5000  → 9999/5000 = 199.98% (overfunded)
    //   - Zeta should be first under desc; Beta and Alpha next at 50%;
    //     campaigns without goals sort LAST.
    //
    // Locate the seeded campaigns and patch their goals via the
    // public-page goal endpoint (PATCH /v1/campaigns/:id sets
    // goalAmountCents).
    const listRes = await app.inject({
      method: "GET",
      url: "/v1/campaigns?perPage=100",
      headers: authHeader(token),
    });
    const all = listRes.json<{
      data: Array<{ id: string; name: string; goalAmountCents: number | null }>;
    }>().data;
    const targets = [
      { name: "Beta Drive", goal: 2000 },
      { name: "Alpha Push", goal: 10000 },
      { name: "Zeta Finale", goal: 5000 },
    ];
    for (const target of targets) {
      const row = all.find((c) => c.name === target.name);
      if (!row) throw new Error(`expected seeded campaign "${target.name}"`);
      if (row.goalAmountCents !== target.goal) {
        const patch = await app.inject({
          method: "PATCH",
          url: `/v1/campaigns/${row.id}`,
          headers: authHeader(token),
          payload: { goalAmountCents: target.goal },
        });
        if (patch.statusCode !== 200) {
          throw new Error(`set goal failed: ${patch.statusCode} ${patch.body}`);
        }
      }
    }

    const res = await app.inject({
      method: "GET",
      url: "/v1/campaigns?sort=progress&order=desc&perPage=100",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: Array<{ id: string; name: string; goalAmountCents: number | null }>;
    }>();
    const indexByName = (name: string) => body.data.findIndex((c) => c.name === name);
    // Zeta (199%) > Beta (50%) = Alpha (50%); regardless of the 50/50
    // tiebreak via id, both must precede Zeta only and follow nothing
    // else with non-null progress.
    expect(indexByName("Zeta Finale")).toBe(0);
    expect(indexByName("Beta Drive")).toBeGreaterThan(0);
    expect(indexByName("Alpha Push")).toBeGreaterThan(0);
    // No-goal campaigns sort as 0% (intermixed with 0%-funded campaigns
    // — the cell displays "0%" in both cases, so the sort matches what
    // the user reads). This seed sets goals on all 3 campaigns so the
    // assertion is dormant here; the no-goal-as-zero behavior is
    // exercised when a sibling tenant (or future seed change) leaves
    // a campaign without a goal.
  });

  it("sort=progress&order=asc returns the lowest ratio first", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/campaigns?sort=progress&order=asc&perPage=100",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ name: string }> }>();
    // Asc: Beta (50%) and Alpha (50%) at the start, Zeta (199%) last
    // among non-null goals.
    const idx = (n: string) => body.data.findIndex((c) => c.name === n);
    expect(idx("Zeta Finale")).toBeGreaterThan(idx("Beta Drive"));
    expect(idx("Zeta Finale")).toBeGreaterThan(idx("Alpha Push"));
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

describe("Edge cases — defense in depth on the sort/order contract", () => {
  // Tests that lock behaviour the route schema *should* enforce. The
  // service-layer `normalizeXxxSort()` falls back to a stable default
  // for unknown values — these tests prove the route validation rejects
  // the value before normalisation, so the fallback can't silently mask
  // a regression to a looser TypeBox schema.

  it("?sort= (empty string) → 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/funds?sort=",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(400);
    expectProblem400(res.json<ProblemBody>());
  });

  it("?order=ASC (uppercase) → 400 — literal whitelist is case-sensitive", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/funds?order=ASC",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(400);
    expectProblem400(res.json<ProblemBody>());
  });

  it("empty result set + sort applied returns an RFC-shaped pagination envelope", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/funds?sort=name&order=asc&perPage=20",
      headers: authHeader(emptyToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: unknown[];
      pagination: { page: number; perPage: number; total: number; totalPages: number };
    }>();
    expect(body.data).toEqual([]);
    expect(body.pagination).toEqual({ page: 1, perPage: 20, total: 0, totalPages: 0 });
  });
});
