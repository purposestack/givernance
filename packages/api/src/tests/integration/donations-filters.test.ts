/**
 * Integration tests for donations advanced filtering
 * (flag `donations.advanced_filters`).
 *
 * Covers: the `?filters=` DSL param on GET /v1/donations (flag-off 404
 * posture, every field lane, EUR→cents scaling, end-of-day date bounds,
 * enum/uuid value gates, virtual EXISTS lanes, joined donor-name search,
 * composition + caps, injection heuristics, legacy-param composition,
 * sort interplay), the /v1/donations/filter/{fields,preview,suggestions}
 * routes, and cross-tenant isolation. Runs under BOTH CI roles — the
 * routes set tenant context via `withTenantContext`, the harness uses the
 * owner pool from tests/helpers/db.js (issue #455 split).
 */

import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import {
  campaigns,
  constituents,
  donationAllocations,
  donations,
  featureFlags,
  funds,
  pledgeInstallments,
  pledges,
  receipts,
} from "@givernance/shared/schema";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { flagService } from "../../lib/flags/flag-service.js";
import { redis } from "../../lib/redis.js";
import type { FilterQuery } from "../../modules/constituents/filters/types.js";
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

const FLAG = FEATURE_FLAG_KEYS.DONATIONS_ADVANCED_FILTERS;

async function setFlag(enabled: boolean) {
  await db.update(featureFlags).set({ enabled }).where(eq(featureFlags.key, FLAG));
  await flagService.invalidate();
  await flagService.invalidateTenant(ORG_A);
  await flagService.invalidateTenant(ORG_B);
}

function filtersUrl(query: FilterQuery, extra = "") {
  return `/v1/donations?filters=${encodeURIComponent(JSON.stringify(query))}${extra}`;
}

async function cleanup() {
  await db.execute(sql`DELETE FROM pledge_installments WHERE org_id IN (${ORG_A}, ${ORG_B})`);
  await db.execute(sql`DELETE FROM pledges WHERE org_id IN (${ORG_A}, ${ORG_B})`);
  await db.execute(sql`DELETE FROM receipts WHERE org_id IN (${ORG_A}, ${ORG_B})`);
  await db.execute(sql`DELETE FROM donation_allocations WHERE org_id IN (${ORG_A}, ${ORG_B})`);
  await db.execute(sql`DELETE FROM donations WHERE org_id IN (${ORG_A}, ${ORG_B})`);
  await db.execute(sql`DELETE FROM funds WHERE org_id IN (${ORG_A}, ${ORG_B})`);
  await db.execute(sql`DELETE FROM campaign_constituents WHERE org_id IN (${ORG_A}, ${ORG_B})`);
  await db.execute(sql`DELETE FROM campaign_documents WHERE org_id IN (${ORG_A}, ${ORG_B})`);
  await db.execute(sql`DELETE FROM campaigns WHERE org_id IN (${ORG_A}, ${ORG_B})`);
  await db.execute(sql`DELETE FROM constituents WHERE org_id IN (${ORG_A}, ${ORG_B})`);
}

describe("Donations advanced filters", () => {
  let app: FastifyInstance;
  let token: string;
  let tokenB: string;

  // Fixture ids (seeded once in beforeAll — all tests are read-only).
  let campaignId: string;
  let fundId: string;
  let d1: string; // Alice — €50 cleared stripe/card, campaign, receipt generated
  let d2: string; // Bob — €250 pending manual/check, fund-allocated, no receipt
  let d3: string; // Alice — €1000 refunded camt053, pledge installment, receipt pending
  let dB: string; // ORG_B — Alice Martin's €50 donation (isolation decoy)

  beforeAll(async () => {
    app = await createServer();
    await app.ready();
    await ensureTestTenants();
    token = signToken(app);
    tokenB = signTokenB(app);

    await cleanup();
    await setFlag(true);

    // ── ORG_A fixtures ─────────────────────────────────────────────────
    const [alice, bob] = await db
      .insert(constituents)
      .values([
        { orgId: ORG_A, firstName: "Alice", lastName: "Martin", email: "alice@example.org" },
        { orgId: ORG_A, firstName: "Bob", lastName: "Dupont", email: "bob@example.org" },
      ])
      .returning({ id: constituents.id });

    const [campaign] = await db
      .insert(campaigns)
      .values({ orgId: ORG_A, name: "Spring Gala", type: "digital" })
      .returning({ id: campaigns.id });
    campaignId = campaign!.id;

    const [fund] = await db
      .insert(funds)
      .values({ orgId: ORG_A, name: "Building Fund" })
      .returning({ id: funds.id });
    fundId = fund!.id;

    const inserted = await db
      .insert(donations)
      .values([
        {
          orgId: ORG_A,
          constituentId: alice!.id,
          amountCents: 5000,
          amountBaseCents: 5000,
          campaignId,
          status: "cleared",
          paymentSource: "stripe",
          paymentMethod: "card",
          donatedAt: new Date("2026-03-15T09:00:00Z"),
          fiscalYear: 2026,
        },
        {
          orgId: ORG_A,
          constituentId: bob!.id,
          amountCents: 25000,
          amountBaseCents: 25000,
          status: "pending",
          paymentSource: "manual",
          paymentMethod: "check",
          donatedAt: new Date("2026-06-10T10:00:00Z"),
          fiscalYear: 2026,
        },
        {
          orgId: ORG_A,
          constituentId: alice!.id,
          amountCents: 100000,
          amountBaseCents: 100000,
          status: "refunded",
          refundedAt: new Date("2026-01-05T12:00:00Z"),
          paymentSource: "camt053",
          paymentMethod: null,
          paymentRef: "REF-123",
          donatedAt: new Date("2025-12-31T23:00:00Z"),
          fiscalYear: 2025,
        },
      ])
      .returning({ id: donations.id });
    [d1, d2, d3] = inserted.map((r) => r.id) as [string, string, string];

    await db.insert(receipts).values([
      {
        orgId: ORG_A,
        donationId: d1,
        receiptNumber: "REC-2026-0001",
        fiscalYear: 2026,
        s3Path: "receipts/test/d1.pdf",
        status: "generated",
      },
      {
        orgId: ORG_A,
        donationId: d3,
        receiptNumber: "REC-2025-0001",
        fiscalYear: 2025,
        s3Path: "receipts/test/d3.pdf",
        status: "pending",
      },
    ]);

    await db
      .insert(donationAllocations)
      .values({ orgId: ORG_A, donationId: d2, fundId, amountCents: 25000 });

    const [pledge] = await db
      .insert(pledges)
      .values({
        orgId: ORG_A,
        constituentId: alice!.id,
        amountCents: 100000,
        amountBaseCents: 100000,
        frequency: "yearly",
      })
      .returning({ id: pledges.id });
    await db.insert(pledgeInstallments).values({
      orgId: ORG_A,
      pledgeId: pledge!.id,
      donationId: d3,
      expectedAt: new Date("2025-12-31T00:00:00Z"),
      amountCents: 100000,
    });

    // ── ORG_B decoys (same donor name, own campaign/fund) ──────────────
    const [aliceB] = await db
      .insert(constituents)
      .values({ orgId: ORG_B, firstName: "Alice", lastName: "Martin", email: "alice@org-b.org" })
      .returning({ id: constituents.id });
    await db.insert(campaigns).values({ orgId: ORG_B, name: "Org B Gala", type: "digital" });
    await db.insert(funds).values({ orgId: ORG_B, name: "Org B Fund" });
    const [donationB] = await db
      .insert(donations)
      .values({
        orgId: ORG_B,
        constituentId: aliceB!.id,
        amountCents: 5000,
        amountBaseCents: 5000,
        status: "cleared",
        paymentSource: "stripe",
        paymentMethod: "card-b",
        donatedAt: new Date("2026-03-15T09:00:00Z"),
      })
      .returning({ id: donations.id });
    dB = donationB!.id;
  });

  afterAll(async () => {
    await cleanup();
    await setFlag(false);
    await app.close();
  });

  beforeEach(async () => {
    // Rate-limit state must not bleed across tests (preview is 20/min).
    const rlKeys = await redis.keys("fastify-rate-limit-*");
    if (rlKeys.length > 0) await redis.del(...rlKeys);
  });

  async function listIds(query: FilterQuery, extra = "", useToken = token): Promise<string[]> {
    const res = await app.inject({
      method: "GET",
      url: filtersUrl(query, extra),
      headers: authHeader(useToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    return body.data.map((row: { id: string }) => row.id).sort();
  }

  const cond = (field: string, operator: string, value?: unknown): FilterQuery =>
    ({ operator: "AND", conditions: [{ field, operator, value }] }) as FilterQuery;

  // ── Flag-off posture ─────────────────────────────────────────────────

  describe("flag off", () => {
    beforeEach(async () => {
      await setFlag(false);
    });

    afterAll(async () => {
      await setFlag(true);
    });

    it("?filters= param 404s (the param does not exist)", async () => {
      const res = await app.inject({
        method: "GET",
        url: filtersUrl(cond("donation.status", "eq", "cleared")),
        headers: authHeader(token),
      });
      expect(res.statusCode).toBe(404);
    });

    it("the plain list route still works (bug-fix surface, not gated)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/donations",
        headers: authHeader(token),
      });
      expect(res.statusCode).toBe(200);
    });

    it("filter sub-routes 404 (fields, preview, suggestions) — even unauthenticated", async () => {
      for (const [method, url, payload] of [
        ["GET", "/v1/donations/filter/fields", undefined],
        ["POST", "/v1/donations/filter/preview", { query: { operator: "AND", conditions: [] } }],
        ["GET", "/v1/donations/filter/suggestions?field=donation.paymentMethod", undefined],
      ] as const) {
        const authed = await app.inject({
          method,
          url,
          headers: authHeader(token),
          ...(payload ? { payload } : {}),
        });
        expect(authed.statusCode).toBe(404);
        const anonymous = await app.inject({ method, url, ...(payload ? { payload } : {}) });
        expect(anonymous.statusCode).toBe(404);
      }
    });
  });

  // ── Field lanes ──────────────────────────────────────────────────────

  it("amount gte scales EUR to cents (100 EUR ⇒ 10000 cents)", async () => {
    // d1 = €50, d2 = €250, d3 = €1000 — a raw-cents comparison (100 vs
    // 5000) would match everything.
    expect(await listIds(cond("donation.amount", "gte", 100))).toEqual([d2, d3].sort());
  });

  it("amount between [40, 60] EUR matches only the €50 gift", async () => {
    expect(await listIds(cond("donation.amount", "between", [40, 60]))).toEqual([d1]);
  });

  it("donatedAt between includes the whole upper-bound day (end-of-day)", async () => {
    // d2 is at 10:00 ON the upper-bound day — midnight-cast would drop it.
    expect(
      await listIds(cond("donation.donatedAt", "between", ["2026-03-01", "2026-06-10"])),
    ).toEqual([d1, d2].sort());
  });

  it("status eq (Postgres enum lane)", async () => {
    expect(await listIds(cond("donation.status", "eq", "pending"))).toEqual([d2]);
  });

  it("status with an out-of-set value is a clean 400, not an enum-cast 500", async () => {
    const res = await app.inject({
      method: "GET",
      url: filtersUrl(cond("donation.status", "eq", "bogus")),
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain("donation.status");
  });

  it("paymentSource in [manual, camt053]", async () => {
    expect(await listIds(cond("donation.paymentSource", "in", ["manual", "camt053"]))).toEqual(
      [d2, d3].sort(),
    );
  });

  it("paymentMethod isNull / contains", async () => {
    expect(await listIds(cond("donation.paymentMethod", "isNull"))).toEqual([d3]);
    expect(await listIds(cond("donation.paymentMethod", "contains", "car"))).toEqual([d1]);
  });

  it("paymentRef eq", async () => {
    expect(await listIds(cond("donation.paymentRef", "eq", "REF-123"))).toEqual([d3]);
  });

  it("refundedAt isNotNull ≡ was refunded", async () => {
    expect(await listIds(cond("donation.refundedAt", "isNotNull"))).toEqual([d3]);
  });

  it("fiscalYear in [2025]", async () => {
    expect(await listIds(cond("donation.fiscalYear", "in", [2025]))).toEqual([d3]);
  });

  it("campaign eq by id / isNull ≡ no campaign", async () => {
    expect(await listIds(cond("donation.campaign", "eq", campaignId))).toEqual([d1]);
    expect(await listIds(cond("donation.campaign", "isNull"))).toEqual([d2, d3].sort());
  });

  it("campaign with a non-uuid value is a clean 400, not a cast 500", async () => {
    const res = await app.inject({
      method: "GET",
      url: filtersUrl(cond("donation.campaign", "eq", "not-a-uuid")),
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain("UUID");
  });

  it("fund in [id] via the allocations EXISTS lane / isNull ≡ unallocated", async () => {
    expect(await listIds(cond("donation.fund", "in", [fundId]))).toEqual([d2]);
    expect(await listIds(cond("donation.fund", "isNull"))).toEqual([d1, d3].sort());
  });

  it("receiptStatus eq generated / isNull ≡ unreceipted", async () => {
    expect(await listIds(cond("donation.receiptStatus", "eq", "generated"))).toEqual([d1]);
    expect(await listIds(cond("donation.receiptStatus", "isNull"))).toEqual([d2]);
  });

  it("isPledgeInstallment eq true/false via the installments EXISTS lane", async () => {
    expect(await listIds(cond("donation.isPledgeInstallment", "eq", true))).toEqual([d3]);
    expect(await listIds(cond("donation.isPledgeInstallment", "eq", false))).toEqual(
      [d1, d2].sort(),
    );
  });

  it("isPledgeInstallment with a non-boolean value 400s (never silently dropped)", async () => {
    const res = await app.inject({
      method: "GET",
      url: filtersUrl(cond("donation.isPledgeInstallment", "eq", "yes")),
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(400);
  });

  it("donor.name contains via the joined constituents row (case-insensitive)", async () => {
    expect(await listIds(cond("donor.name", "contains", "alice mar"))).toEqual([d1, d3].sort());
  });

  it("donor.name eq is case-insensitive exact", async () => {
    expect(await listIds(cond("donor.name", "eq", "bob dupont"))).toEqual([d2]);
  });

  it("donor.email endsWith", async () => {
    expect(await listIds(cond("donor.email", "endsWith", "@example.org"))).toEqual(
      [d1, d2, d3].sort(),
    );
  });

  // ── Composition, caps, validation ────────────────────────────────────

  it("OR composition across lanes (column + virtual)", async () => {
    const query: FilterQuery = {
      operator: "OR",
      conditions: [
        { field: "donation.status", operator: "eq", value: "refunded" },
        { field: "donation.receiptStatus", operator: "eq", value: "generated" },
      ],
    };
    expect(await listIds(query)).toEqual([d1, d3].sort());
  });

  it("nested subConditions groups", async () => {
    const query = {
      operator: "AND",
      conditions: [
        { field: "donation.amount", operator: "gte", value: 10 },
        {
          field: "donation.status",
          operator: "eq",
          value: "cleared",
          subConditions: {
            operator: "OR",
            conditions: [
              { field: "donation.paymentMethod", operator: "eq", value: "check" },
              { field: "donation.paymentSource", operator: "eq", value: "camt053" },
            ],
          },
        },
      ],
    } as unknown as FilterQuery;
    // subConditions REPLACE the leaf (constituents-engine semantics):
    // amount ≥ €10 AND (check OR camt053) → d2, d3.
    expect(await listIds(query)).toEqual([d2, d3].sort());
  });

  it("rejects more than 10 conditions", async () => {
    const query: FilterQuery = {
      operator: "AND",
      conditions: Array.from({ length: 11 }, () => ({
        field: "donation.amount",
        operator: "gte" as const,
        value: 1,
      })),
    };
    const res = await app.inject({
      method: "GET",
      url: filtersUrl(query),
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects nesting deeper than 3 levels", async () => {
    let query = {
      operator: "AND",
      conditions: [{ field: "donation.amount", operator: "gte", value: 1 }],
    } as unknown as FilterQuery;
    for (let i = 0; i < 4; i++) {
      query = {
        operator: "AND",
        conditions: [{ field: "donation.amount", operator: "gte", value: 1, subConditions: query }],
      } as unknown as FilterQuery;
    }
    const res = await app.inject({
      method: "GET",
      url: filtersUrl(query),
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects patterns (constituent-grain concept)", async () => {
    const query = {
      operator: "AND",
      conditions: [{ field: "donation.status", operator: "eq", value: "cleared" }],
      patterns: ["LYBUNT"],
    } as unknown as FilterQuery;
    const res = await app.inject({
      method: "GET",
      url: filtersUrl(query),
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain("Patterns");
  });

  it("rejects unknown fields (DSL never resolves raw column names)", async () => {
    const res = await app.inject({
      method: "GET",
      url: filtersUrl(cond("donations.amount_cents", "eq", 50)),
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects operators not allowed for the field", async () => {
    const res = await app.inject({
      method: "GET",
      url: filtersUrl(cond("donation.amount", "contains", "50")),
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects suspicious SQL-injection values with 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: filtersUrl(cond("donor.name", "contains", "'; DROP TABLE donations;--")),
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for filters that are not valid JSON / not an object", async () => {
    for (const raw of ["not-json", "%22scalar%22", "null", "%5B%5D"]) {
      const res = await app.inject({
        method: "GET",
        url: `/v1/donations?filters=${raw}`,
        headers: authHeader(token),
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("non-numeric value on a number field is a clean 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: filtersUrl(cond("donation.amount", "gte", "abc")),
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(400);
  });

  // ── Nested-leaf validation (leaves inside subConditions must hit the
  //    same gates as top-level ones — a hand-edited URL can nest anything) ──

  describe("subConditions leaves are validated like top-level conditions", () => {
    /** Valid outer leaf wrapping one nested leaf under test. */
    const nesting = (leaf: Record<string, unknown>): FilterQuery =>
      ({
        operator: "AND",
        conditions: [
          {
            field: "donation.status",
            operator: "eq",
            value: "cleared",
            subConditions: { operator: "OR", conditions: [leaf] },
          },
        ],
      }) as unknown as FilterQuery;

    async function expectStatus(query: FilterQuery, status: number) {
      const res = await app.inject({
        method: "GET",
        url: filtersUrl(query),
        headers: authHeader(token),
      });
      expect(res.statusCode).toBe(status);
      // The same query through the preview route must agree (no 500s).
      const preview = await app.inject({
        method: "POST",
        url: "/v1/donations/filter/preview",
        headers: authHeader(token),
        payload: { query },
      });
      expect(preview.statusCode).toBe(status);
    }

    it("nested unknown field → 400 (never silently dropped into an unfiltered list)", async () => {
      await expectStatus(nesting({ field: "totally.unknown", operator: "eq", value: "x" }), 400);
    });

    it("nested non-numeric amount → 400 (never a NaN-bind 500)", async () => {
      await expectStatus(nesting({ field: "donation.amount", operator: "gt", value: "abc" }), 400);
    });

    it("nested disallowed operator → 400 (never an enum-ILIKE 500)", async () => {
      await expectStatus(
        nesting({ field: "donation.status", operator: "contains", value: "cleared" }),
        400,
      );
    });

    it("nested out-of-set enum value → 400", async () => {
      await expectStatus(
        nesting({ field: "donation.status", operator: "eq", value: "bogus" }),
        400,
      );
    });

    it("nested suspicious value → 400 (injection heuristics reach nested leaves)", async () => {
      await expectStatus(
        nesting({ field: "donor.name", operator: "contains", value: "x'; DROP TABLE donations--" }),
        400,
      );
    });

    it("a valid nested leaf still works end-to-end", async () => {
      await expectStatus(nesting({ field: "donation.amount", operator: "gte", value: 1 }), 200);
    });
  });

  // ── Value-shape gates: arrays and empties that would silently drop or
  //    500 must be clean 400s ────────────────────────────────────────────

  it("array value on a scalar operator → 400 (virtual lane would silently drop it)", async () => {
    // Before the gate this returned 200 with the condition dropped — the
    // full unfiltered list under an active-looking filter chip.
    const res = await app.inject({
      method: "GET",
      url: filtersUrl(cond("donation.receiptStatus", "eq", ["generated"])),
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(400);
  });

  it("array value on a scalar operator → 400 (plain enum column would 500 at SQL)", async () => {
    const res = await app.inject({
      method: "GET",
      url: filtersUrl(cond("donation.status", "eq", ["pending"])),
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(400);
  });

  it("empty donor.name string → 400 (would compile to undefined → silent unfilter)", async () => {
    for (const operator of ["eq", "contains", "startsWith"]) {
      const res = await app.inject({
        method: "GET",
        url: filtersUrl(cond("donor.name", operator, "")),
        headers: authHeader(token),
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("fund in [] → 400 (fund lane would drop it; plain columns would match nothing)", async () => {
    const res = await app.inject({
      method: "GET",
      url: filtersUrl(cond("donation.fund", "in", [])),
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(400);
  });

  // ── Interplay with legacy params + sort ──────────────────────────────

  it("composes (AND) with legacy list params — amountMin stays cents", async () => {
    // amountMin=20000 cents (€200) keeps d2 + d3; DSL status=pending keeps d2.
    expect(await listIds(cond("donation.status", "eq", "pending"), "&amountMin=20000")).toEqual([
      d2,
    ]);
  });

  it("plays with server-side sort", async () => {
    const res = await app.inject({
      method: "GET",
      url: filtersUrl(cond("donation.amount", "gte", 100), "&sort=amountCents&order=asc"),
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const ids = res.json().data.map((row: { id: string }) => row.id);
    expect(ids).toEqual([d2, d3]);
  });

  it("pagination totals reflect the filtered set", async () => {
    const res = await app.inject({
      method: "GET",
      url: filtersUrl(cond("donation.amount", "gte", 100), "&perPage=1"),
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().pagination.total).toBe(2);
  });

  // ── Cross-tenant isolation ───────────────────────────────────────────

  it("donor-name search never crosses tenants (org predicate in the join clause)", async () => {
    const idsA = await listIds(cond("donor.name", "contains", "alice"));
    expect(idsA).toEqual([d1, d3].sort());
    expect(idsA).not.toContain(dB);

    const idsB = await listIds(cond("donor.name", "contains", "alice"), "", tokenB);
    expect(idsB).toEqual([dB]);
  });

  it("org B cannot match org A's campaign id (explicit eq(orgId) on donations)", async () => {
    expect(await listIds(cond("donation.campaign", "eq", campaignId), "", tokenB)).toEqual([]);
  });

  // ── /filter/fields catalog ───────────────────────────────────────────

  it("fields catalog: types, operators, cents unit, enum + entity options", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/donations/filter/fields",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const fields = res.json().data.fields as Array<Record<string, unknown>>;
    const byName = new Map(fields.map((f) => [f.name, f]));

    const amount = byName.get("donation.amount") as Record<string, unknown>;
    expect(amount.valueUnit).toBe("cents");
    expect(amount.labelKind).toBe("i18n");
    expect(amount.label).toBe("fields.donation.amount");

    const status = byName.get("donation.status") as { options: Array<{ id: string }> } & Record<
      string,
      unknown
    >;
    expect(status.optionsKind).toBe("enum");
    expect(status.options.map((o) => o.id).sort()).toEqual([
      "cleared",
      "failed",
      "pending",
      "refunded",
    ]);

    const campaign = byName.get("donation.campaign") as {
      options: Array<{ id: string; label: string }>;
    } & Record<string, unknown>;
    expect(campaign.optionsKind).toBe("entity");
    expect(campaign.options).toEqual([{ id: campaignId, label: "Spring Gala", active: true }]);

    const fund = byName.get("donation.fund") as {
      options: Array<{ id: string; label: string }>;
    } & Record<string, unknown>;
    expect(fund.options).toEqual([{ id: fundId, label: "Building Fund", active: true }]);

    // Super-admin-locked columns must never surface.
    expect(fields.some((f) => String(f.name).toLowerCase().includes("fee"))).toBe(false);
  });

  it("fields catalog is org-scoped (org B sees only its own campaigns/funds)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/donations/filter/fields",
      headers: authHeader(tokenB),
    });
    expect(res.statusCode).toBe(200);
    const fields = res.json().data.fields as Array<{
      name: string;
      options?: Array<{ label: string }>;
    }>;
    const campaign = fields.find((f) => f.name === "donation.campaign");
    expect(campaign?.options?.map((o) => o.label)).toEqual(["Org B Gala"]);
  });

  it("fields catalog requires auth (401 when flag on)", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/donations/filter/fields" });
    expect(res.statusCode).toBe(401);
  });

  // ── /filter/preview ──────────────────────────────────────────────────

  it("preview returns the matching count", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/donations/filter/preview",
      headers: authHeader(token),
      payload: { query: cond("donation.status", "eq", "cleared") },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.count).toBe(1);
  });

  it("preview 400s invalid queries", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/donations/filter/preview",
      headers: authHeader(token),
      payload: { query: cond("nope.nope", "eq", "x") },
    });
    expect(res.statusCode).toBe(400);
  });

  // ── /filter/suggestions ──────────────────────────────────────────────

  it("suggestions: org-scoped DISTINCT payment methods", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/donations/filter/suggestions?field=donation.paymentMethod",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    // "card-b" belongs to ORG_B and must never leak.
    expect(res.json().data).toEqual(["card", "check"]);
  });

  it("suggestions: unsupported fields return an empty list", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/donations/filter/suggestions?field=donation.status",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([]);
  });
});
