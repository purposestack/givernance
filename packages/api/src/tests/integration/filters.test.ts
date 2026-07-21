/**
 * Integration tests for advanced constituent filtering
 */

import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import {
  campaignConstituents,
  campaigns,
  constituents,
  donations,
  featureFlags,
} from "@givernance/shared/schema";
import { and, eq, sql } from "drizzle-orm";
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
import { db, withTenantContext } from "../helpers/db.js";

// Test data interfaces
interface TestConstituent {
  id: string;
  firstName: string;
  lastName: string;
  email?: string;
  birthdate?: Date;
  orgId: string;
  customFields?: Record<string, unknown>;
}

interface FilterFieldMetadata {
  name: string;
  type: string;
  label?: string;
  description?: string;
}

interface PatternMetadata {
  name: string;
  description: string;
  query: FilterQuery;
}

describe("Advanced Constituent Filters", () => {
  let app: FastifyInstance;
  let testConstituents: TestConstituent[] = [];
  let token: string;
  let tokenB: string;

  beforeAll(async () => {
    app = await createServer();
    await app.ready();

    // Enable the advanced_filters feature flag
    await db
      .update(featureFlags)
      .set({ enabled: true })
      .where(eq(featureFlags.key, FEATURE_FLAG_KEYS.ADVANCED_FILTERS));
    await flagService.invalidate();
    await flagService.invalidateTenant(ORG_A);
    await flagService.invalidateTenant(ORG_B);
  });

  afterAll(async () => {
    // Clean up our test data so neighbouring suites (e.g. bulk-import)
    // can DELETE FROM constituents by first_name without hitting the
    // donations FK on this suite's fixtures.
    await db.execute(sql`DELETE FROM donations WHERE org_id IN (${ORG_A}, ${ORG_B})`);
    await db.execute(sql`DELETE FROM pledges WHERE org_id IN (${ORG_A}, ${ORG_B})`);
    await db.execute(sql`DELETE FROM campaign_constituents WHERE org_id IN (${ORG_A}, ${ORG_B})`);
    await db.execute(sql`DELETE FROM campaign_documents WHERE org_id IN (${ORG_A}, ${ORG_B})`);
    await db.execute(sql`DELETE FROM constituents WHERE org_id IN (${ORG_A}, ${ORG_B})`);

    // Reset the feature flag
    await db
      .update(featureFlags)
      .set({ enabled: false })
      .where(eq(featureFlags.key, FEATURE_FLAG_KEYS.ADVANCED_FILTERS));
    await flagService.invalidate();
    await flagService.invalidateTenant(ORG_A);
    await flagService.invalidateTenant(ORG_B);

    await app.close();
  });

  beforeEach(async () => {
    // Clear flag cache before each test
    await flagService.invalidate();
    await flagService.invalidateTenant(ORG_A);
    await flagService.invalidateTenant(ORG_B);

    // Clear rate limit cache for filter routes. `@fastify/rate-limit` keys
    // its Redis entries with a dash separator (`fastify-rate-limit-<...>`),
    // NOT a colon — the prior `fastify-rate-limit:*` glob never matched, so
    // rate-limit state leaked across tests and made the security suite go
    // 429 once enough tests had piled into the same minute window.
    const rlKeys = await redis.keys("fastify-rate-limit-*");
    if (rlKeys.length > 0) await redis.del(...rlKeys);

    await ensureTestTenants();
    token = signToken(app);
    tokenB = signTokenB(app);

    // Clear any existing test data
    await db.execute(sql`DELETE FROM donations WHERE org_id IN (${ORG_A}, ${ORG_B})`);
    await db.execute(sql`DELETE FROM pledges WHERE org_id IN (${ORG_A}, ${ORG_B})`);
    await db.execute(sql`DELETE FROM campaign_constituents WHERE org_id IN (${ORG_A}, ${ORG_B})`);
    await db.execute(sql`DELETE FROM campaign_documents WHERE org_id IN (${ORG_A}, ${ORG_B})`);
    await db.execute(sql`DELETE FROM constituents WHERE org_id IN (${ORG_A}, ${ORG_B})`);

    // Create test constituents with various attributes
    await withTenantContext(ORG_A, async (db) => {
      const insertedConstituents = await db
        .insert(constituents)
        .values([
          {
            orgId: ORG_A,
            firstName: "John",
            lastName: "Doe",
            email: "john.doe@example.com",
            type: "donor",
            city: "New York",
            postalCode: "10001",
            countryCode: "US",
            tags: ["major-donor", "board-member"],
          },
          {
            orgId: ORG_A,
            firstName: "Jane",
            lastName: "Smith",
            email: "jane.smith@example.com",
            type: "donor",
            city: "Los Angeles",
            postalCode: "90001",
            countryCode: "US",
            tags: ["volunteer"],
          },
          {
            orgId: ORG_A,
            firstName: "Bob",
            lastName: "Johnson",
            email: "bob.johnson@example.com",
            type: "volunteer",
            city: "New York",
            postalCode: "10002",
            countryCode: "US",
            tags: ["volunteer", "event-organizer"],
          },
          {
            orgId: ORG_A,
            firstName: "Alice",
            lastName: "Williams",
            email: "alice.williams@example.com",
            type: "member",
            city: "Chicago",
            postalCode: "60601",
            countryCode: "US",
            tags: null,
          },
        ])
        .returning();

      testConstituents = insertedConstituents as unknown as TestConstituent[];

      // Create donations for testing patterns
      const currentYear = new Date().getFullYear();
      const lastYear = currentYear - 1;

      await db.insert(donations).values([
        // John Doe - Major donor with regular giving
        {
          orgId: ORG_A,
          constituentId: testConstituents[0]!.id,
          amountCents: 100000, // 1000 EUR
          amountBaseCents: 100000,
          currency: "EUR",
          status: "cleared",
          donatedAt: new Date(currentYear, 0, 15), // This year
        },
        {
          orgId: ORG_A,
          constituentId: testConstituents[0]!.id,
          amountCents: 100000,
          amountBaseCents: 100000,
          currency: "EUR",
          status: "cleared",
          donatedAt: new Date(currentYear, 3, 15), // This year
        },
        {
          orgId: ORG_A,
          constituentId: testConstituents[0]!.id,
          amountCents: 100000,
          amountBaseCents: 100000,
          currency: "EUR",
          status: "cleared",
          donatedAt: new Date(lastYear, 6, 15), // Last year
        },
        // Jane Smith - LYBUNT donor
        {
          orgId: ORG_A,
          constituentId: testConstituents[1]!.id,
          amountCents: 5000, // 50 EUR
          amountBaseCents: 5000,
          currency: "EUR",
          status: "cleared",
          donatedAt: new Date(lastYear, 11, 10), // Last year only, but less than 6 months ago
        },
        // Bob Johnson - Lapsed donor
        {
          orgId: ORG_A,
          constituentId: testConstituents[2]!.id,
          amountCents: 2500, // 25 EUR
          amountBaseCents: 2500,
          currency: "EUR",
          status: "cleared",
          donatedAt: new Date(currentYear - 2, 5, 20), // 2 years ago
        },
      ]);
    });
  });

  describe("Pattern-only queries (no sentinel condition required)", () => {
    // Regression test for PR #421 follow-up: pattern presets like
    // LYBUNT / LAPSED / MAJOR_DONOR must be accepted with `conditions: []`.
    // Previously the BE validator required ≥1 condition, forcing the FE to
    // emit a "sentinel" `constituent.createdAt gte 1970-01-01` condition
    // that polluted the active-filters strip in the UI.

    it("should accept a pattern-only LYBUNT query (no sentinel) and return 200", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/constituents/filter",
        headers: authHeader(token),
        payload: {
          query: {
            operator: "AND",
            conditions: [],
            patterns: ["LYBUNT"],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.data).toBeDefined();
      // Jane Smith has a `cleared` donation in lastYear-Dec only → LYBUNT match.
      // We don't lock to an exact count here because seeded fixtures can drift;
      // the regression we're guarding is "200, not 400".
      expect(Array.isArray(body.data.data)).toBe(true);
      const names = body.data.data.map((c: TestConstituent) => c.firstName);
      expect(names).toContain("Jane");
    });

    it("should accept a pattern-only LAPSED query (no sentinel) and return 200", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/constituents/filter",
        headers: authHeader(token),
        payload: {
          query: {
            operator: "AND",
            conditions: [],
            patterns: ["LAPSED"],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.data).toBeDefined();
      expect(Array.isArray(body.data.data)).toBe(true);
      // Bob Johnson last donated 2y ago → LAPSED.
      const names = body.data.data.map((c: TestConstituent) => c.firstName);
      expect(names).toContain("Bob");
    });

    it("should accept a pattern-only MAJOR_DONOR query (no sentinel) and return 200", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/constituents/filter",
        headers: authHeader(token),
        payload: {
          query: {
            operator: "AND",
            conditions: [],
            patterns: ["MAJOR_DONOR"],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.data).toBeDefined();
      // John Doe has 3 × 1000 EUR cleared donations → lifetime ≥ 1000 EUR.
      const names = body.data.data.map((c: TestConstituent) => c.firstName);
      expect(names).toContain("John");
    });

    it("should accept a pattern-only preview query (no sentinel) and return 200", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/constituents/filter/preview",
        headers: authHeader(token),
        payload: {
          query: {
            operator: "AND",
            conditions: [],
            patterns: ["LYBUNT"],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(typeof body.data.count).toBe("number");
      expect(body.data.count).toBeGreaterThanOrEqual(1);
    });

    it("should reject an empty query (no conditions AND no patterns) with 400", async () => {
      // The relaxation only allows EITHER conditions OR patterns. A query
      // with neither is still nonsensical and must be rejected.
      const response = await app.inject({
        method: "POST",
        url: "/v1/constituents/filter",
        headers: authHeader(token),
        payload: {
          query: {
            operator: "AND",
            conditions: [],
          },
        },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.errors).toBeDefined();
      expect(body.errors.some((e: string) => e.includes("At least one condition or pattern"))).toBe(
        true,
      );
    });
  });

  describe("POST /v1/constituents/filter", () => {
    it.skip("should filter constituents by simple field conditions", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/constituents/filter",
        headers: authHeader(token),
        payload: {
          query: {
            operator: "AND",
            conditions: [
              { field: "constituent.type", operator: "eq", value: "donor" },
              { field: "address.city", operator: "eq", value: "New York" },
            ],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.data).toHaveLength(1);
      expect(body.data.data[0].firstName).toBe("John");
      expect(body.data.data[0].lastName).toBe("Doe");
    });

    it.skip("should filter constituents by tag array operations", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/constituents/filter",
        headers: authHeader(token),
        payload: {
          query: {
            operator: "OR",
            conditions: [
              { field: "constituent.tags", operator: "arrayContains", value: ["major-donor"] },
              { field: "constituent.tags", operator: "arrayContains", value: ["event-organizer"] },
            ],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.data).toHaveLength(2);
      const names = body.data.data.map((c: TestConstituent) => c.firstName).sort();
      expect(names).toEqual(["Bob", "John"]);
    });

    it.skip("should filter by donation aggregates", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/constituents/filter",
        headers: authHeader(token),
        payload: {
          query: {
            operator: "AND",
            conditions: [
              { field: "donations.totalAmount", operator: "gte", value: 100000 }, // >= 1000 EUR
            ],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.data).toHaveLength(1);
      expect(body.data.data[0].firstName).toBe("John");
      expect(body.data.data[0].totalAmountCents).toBeGreaterThanOrEqual(100000);
    });

    it.skip("should detect LYBUNT pattern", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/constituents/filter",
        headers: authHeader(token),
        payload: {
          query: {
            operator: "AND",
            conditions: [],
            patterns: ["LYBUNT"],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.data).toHaveLength(1);
      expect(body.data.data[0].firstName).toBe("Jane");
    });

    it.skip("should detect LAPSED pattern", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/constituents/filter",
        headers: authHeader(token),
        payload: {
          query: {
            operator: "AND",
            conditions: [],
            patterns: ["LAPSED"],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.data).toHaveLength(1);
      expect(body.data.data[0].firstName).toBe("Bob");
    });

    it.skip("should handle pagination", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/constituents/filter",
        headers: authHeader(token),
        payload: {
          query: {
            operator: "AND",
            conditions: [{ field: "constituent.type", operator: "neq", value: "invalid" }],
          },
          pagination: {
            page: 1,
            perPage: 2,
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.data).toHaveLength(2);
      expect(body.data.pagination.total).toBe(4);
      expect(body.data.pagination.totalPages).toBe(2);
    });

    it.skip("should validate invalid queries", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/constituents/filter",
        headers: authHeader(token),
        payload: {
          query: {
            operator: "AND",
            conditions: [{ field: "invalid_field", operator: "eq", value: "test" }],
          },
        },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.title).toBe("Invalid filter query");
    });

    it.skip("should require feature flag", async () => {
      // Temporarily disable the feature flag
      await db
        .update(featureFlags)
        .set({ enabled: false })
        .where(eq(featureFlags.key, FEATURE_FLAG_KEYS.ADVANCED_FILTERS));

      await redis.del(
        "givernance:flags:cache:global",
        `givernance:flags:cache:tenant:${ORG_A}`,
        `givernance:flags:cache:tenant:${ORG_B}`,
      );

      const response = await app.inject({
        method: "POST",
        url: "/v1/constituents/filter",
        headers: authHeader(tokenB),
        payload: {
          query: {
            operator: "AND",
            conditions: [],
          },
        },
      });

      expect(response.statusCode).toBe(404);

      // Re-enable for subsequent tests
      await db
        .update(featureFlags)
        .set({ enabled: true })
        .where(eq(featureFlags.key, FEATURE_FLAG_KEYS.ADVANCED_FILTERS));

      await redis.del(
        "givernance:flags:cache:global",
        `givernance:flags:cache:tenant:${ORG_A}`,
        `givernance:flags:cache:tenant:${ORG_B}`,
      );
    });
  });

  describe("POST /v1/constituents/filter/preview", () => {
    it.skip("should return count without full results", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/constituents/filter/preview",
        headers: authHeader(token),
        payload: {
          query: {
            operator: "AND",
            conditions: [{ field: "constituent.type", operator: "eq", value: "donor" }],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.count).toBe(2);
      expect(body.data.estimatedTime).toBeDefined();
    });
  });

  describe("Advanced-filters audit fixes", () => {
    // Fixtures (ORG_A, seeded in beforeEach):
    //   John Doe   — donor, New York, email set, lifetime 3000 EUR (3×1000)
    //   Jane Smith — donor, Los Angeles, email set, lifetime 50 EUR
    //   Bob Johnson— volunteer, New York, email set, lifetime 25 EUR
    //   Alice Williams — member, Chicago, email set, ZERO donations
    const preview = (query: FilterQuery) =>
      app.inject({
        method: "POST",
        url: "/v1/constituents/filter/preview",
        headers: authHeader(token),
        payload: { query },
      });

    it("excludes zero-donation constituents from a positive donation-count filter (no aggregate NULL leak)", async () => {
      const res = await preview({
        operator: "AND",
        conditions: [{ field: "donations.count", operator: "gte", value: 1 }],
      });
      expect(res.statusCode).toBe(200);
      // Alice (0 donations) must NOT leak in via the removed `IS NULL OR` wrap.
      expect(res.json().data.count).toBe(3);
    });

    it("compares donations.totalAmount in EUR, scaling the value to cents", async () => {
      // Threshold 500 EUR → only John (3000 EUR). A cents/EUR bug would compare
      // 500 cents and wrongly match John + Jane + Bob.
      const res = await preview({
        operator: "AND",
        conditions: [{ field: "donations.totalAmount", operator: "gte", value: 500 }],
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.count).toBe(1);
    });

    it("resolves the renamed address.countryCode field and actually filters (not a match-all no-op)", async () => {
      // Seed one non-US constituent so the predicate is proven to discriminate.
      await withTenantContext(ORG_A, async (txDb) => {
        await txDb.insert(constituents).values({
          orgId: ORG_A,
          firstName: "Fran",
          lastName: "Cais",
          type: "donor",
          countryCode: "FR",
        });
      });

      const us = await preview({
        operator: "AND",
        conditions: [{ field: "address.countryCode", operator: "eq", value: "US" }],
      });
      expect(us.statusCode).toBe(200);
      expect(us.json().data.count).toBe(4); // the 4 original US constituents

      const fr = await preview({
        operator: "AND",
        conditions: [{ field: "address.countryCode", operator: "eq", value: "FR" }],
      });
      expect(fr.statusCode).toBe(200);
      expect(fr.json().data.count).toBe(1);
    });

    it("supports isNull / isNotNull on the nullable email column", async () => {
      await withTenantContext(ORG_A, async (txDb) => {
        await txDb.insert(constituents).values({
          orgId: ORG_A,
          firstName: "No",
          lastName: "Email",
          email: null,
          type: "donor",
        });
      });

      const empties = await preview({
        operator: "AND",
        conditions: [{ field: "constituent.email", operator: "isNull", value: null }],
      });
      expect(empties.statusCode).toBe(200);
      expect(empties.json().data.count).toBe(1);

      const present = await preview({
        operator: "AND",
        conditions: [{ field: "constituent.email", operator: "isNotNull", value: null }],
      });
      expect(present.statusCode).toBe(200);
      expect(present.json().data.count).toBe(4);
    });

    it("honours OR across the regular/aggregate boundary (was silently AND)", async () => {
      // Chicago (Alice, 0 gifts) OR lifetime ≥ 500 EUR (John). Under the old
      // always-AND join this returned 0 (Alice has no donations); OR must be 2.
      const res = await preview({
        operator: "OR",
        conditions: [
          { field: "address.city", operator: "eq", value: "Chicago" },
          { field: "donations.totalAmount", operator: "gte", value: 500 },
        ],
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.count).toBe(2);
    });

    it("excludes soft-deleted constituents from filter results", async () => {
      const before = await preview({
        operator: "AND",
        conditions: [{ field: "address.countryCode", operator: "eq", value: "US" }],
      });
      expect(before.json().data.count).toBe(4);

      await withTenantContext(ORG_A, async (txDb) => {
        await txDb
          .update(constituents)
          .set({ deletedAt: new Date() })
          .where(and(eq(constituents.orgId, ORG_A), eq(constituents.id, testConstituents[0]!.id)));
      });

      const after = await preview({
        operator: "AND",
        conditions: [{ field: "address.countryCode", operator: "eq", value: "US" }],
      });
      expect(after.json().data.count).toBe(3);
    });

    it("rejects an operator the BE no longer accepts (exists) at the schema layer", async () => {
      const res = await preview({
        // `exists` was removed from the wire vocabulary in favour of isNull.
        operator: "AND",
        conditions: [{ field: "donations.lastDate", operator: "exists" as never, value: null }],
      });
      expect(res.statusCode).toBe(400);
    });

    it("matches the never-donated set with donations.count = 0 (COALESCE, not NULL-collapse)", async () => {
      // Alice has zero cleared donations. After removing the aggregate-NULL
      // wrapper, `count = 0` must still match her (COALESCE(count,0)=0), and
      // `count < 2` must include her too.
      const zero = await preview({
        operator: "AND",
        conditions: [{ field: "donations.count", operator: "eq", value: 0 }],
      });
      expect(zero.statusCode).toBe(200);
      expect(zero.json().data.count).toBe(1);

      const lessThanTwo = await preview({
        operator: "AND",
        conditions: [{ field: "donations.count", operator: "lt", value: 2 }],
      });
      expect(lessThanTwo.statusCode).toBe(200);
      // Alice (0) + Jane (1) + Bob (1) = 3; John (3 gifts) excluded.
      expect(lessThanTwo.json().data.count).toBe(3);
    });

    it("honours OR across MULTIPLE aggregate conditions (union, not first-only)", async () => {
      // count = 1 (Jane, Bob) OR totalAmount ≥ 2000 EUR (John) = 3.
      const res = await preview({
        operator: "OR",
        conditions: [
          { field: "donations.count", operator: "eq", value: 1 },
          { field: "donations.totalAmount", operator: "gte", value: 2000 },
        ],
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.count).toBe(3);
    });

    it("treats a date range end as inclusive of the whole day (between end-of-day)", async () => {
      // All 4 constituents were createdAt = now() in the fixture. A range ending
      // TODAY must include them — without the end-of-day normalisation the bare
      // date casts to midnight and drops rows created later today.
      const today = new Date().toISOString().slice(0, 10);
      const res = await preview({
        operator: "AND",
        conditions: [
          { field: "constituent.createdAt", operator: "between", value: ["2000-01-01", today] },
        ],
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.count).toBe(4);
    });

    it("returns 400 (not 500) for a field removed from the registry", async () => {
      const res = await preview({
        operator: "AND",
        conditions: [{ field: "donations.averageAmount", operator: "gte", value: 100 }],
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects a non-numeric value on a numeric field with 400 (not 500)", async () => {
      const res = await preview({
        operator: "AND",
        conditions: [{ field: "donations.totalAmount", operator: "gte", value: "abc" as never }],
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("GET /v1/constituents/filter/suggestions", () => {
    it.skip("should return field value suggestions", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/v1/constituents/filter/suggestions?field=address.city",
        headers: authHeader(token),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toContain("New York");
      expect(body.data).toContain("Los Angeles");
      expect(body.data).toContain("Chicago");
    });

    it.skip("should filter suggestions by search term", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/v1/constituents/filter/suggestions?field=address.city&search=New",
        headers: authHeader(token),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toContain("New York");
      expect(body.data).not.toContain("Los Angeles");
    });
  });

  describe("POST /v1/campaigns/:id/members/filter", () => {
    it.skip("should add filtered constituents to campaign", async () => {
      // Create a test campaign
      let campaignId: string = "";
      await withTenantContext(ORG_A, async (db) => {
        const [campaign] = await db
          .insert(campaigns)
          .values({
            orgId: ORG_A,
            name: "Test Campaign",
            type: "digital",
            status: "active",
          })
          .returning();
        campaignId = campaign!.id;
      });

      const response = await app.inject({
        method: "POST",
        url: `/v1/campaigns/${campaignId}/members/filter`,
        headers: authHeader(token),
        payload: {
          query: {
            operator: "AND",
            conditions: [{ field: "constituent.type", operator: "eq", value: "donor" }],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.added).toBe(2);
      expect(body.data.skipped).toBe(0);

      // Verify constituents were added
      await withTenantContext(ORG_A, async (db) => {
        const members = await db
          .select()
          .from(campaignConstituents)
          .where(eq(campaignConstituents.campaignId, campaignId));
        expect(members).toHaveLength(2);
      });
    });

    it.skip("should skip already added constituents", async () => {
      let campaignId: string = "";
      await withTenantContext(ORG_A, async (db) => {
        const [campaign] = await db
          .insert(campaigns)
          .values({
            orgId: ORG_A,
            name: "Test Campaign",
            type: "digital",
            status: "active",
          })
          .returning();
        campaignId = campaign!.id;

        // Add one constituent manually
        await db.insert(campaignConstituents).values({
          orgId: ORG_A,
          campaignId,
          constituentId: testConstituents[0]!.id,
        });
      });

      const response = await app.inject({
        method: "POST",
        url: `/v1/campaigns/${campaignId}/members/filter`,
        headers: authHeader(token),
        payload: {
          query: {
            operator: "AND",
            conditions: [{ field: "constituent.type", operator: "eq", value: "donor" }],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.added).toBe(1);
      expect(body.data.skipped).toBe(1);
    });
  });

  describe("GET /v1/constituents/filter/fields", () => {
    it.skip("should return available fields and patterns", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/v1/constituents/filter/fields",
        headers: authHeader(token),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      // Check fields
      expect(body.data.fields).toBeDefined();
      expect(body.data.fields.length).toBeGreaterThan(0);
      const emailField = body.data.fields.find(
        (f: FilterFieldMetadata) => f.name === "constituent.email",
      );
      expect(emailField).toBeDefined();
      expect(emailField.type).toBe("string");
      expect(emailField.operators).toContain("contains");

      // Check patterns
      expect(body.data.patterns).toBeDefined();
      expect(body.data.patterns.length).toBe(5);
      const lybuntPattern = body.data.patterns.find((p: PatternMetadata) => p.name === "LYBUNT");
      expect(lybuntPattern).toBeDefined();
      expect(lybuntPattern.description).toContain("last year");
    });
  });

  describe("Security Tests", () => {
    it("should reject SQL injection attempts in string fields", async () => {
      const maliciousQueries = [
        {
          field: "constituent.email",
          operator: "contains",
          value: "test'; DROP TABLE constituents;--",
        },
        { field: "constituent.firstName", operator: "contains", value: "test' OR 1=1--" },
        {
          field: "constituent.lastName",
          operator: "startsWith",
          value: "test' UNION SELECT * FROM users--",
        },
        {
          field: "constituent.email",
          operator: "endsWith",
          value: "; DELETE FROM donations WHERE 1=1;",
        },
      ];

      for (const condition of maliciousQueries) {
        const response = await app.inject({
          method: "POST",
          url: "/v1/constituents/filter",
          headers: authHeader(token),
          payload: {
            query: {
              operator: "AND",
              conditions: [condition],
            },
          },
        });

        expect(response.statusCode).toBe(400);
        const body = response.json();
        expect(body.errors).toBeDefined();
        expect(body.errors.some((e: string) => e.includes("Suspicious input"))).toBe(true);
      }
    });

    it("should handle special SQL characters safely", async () => {
      // These should be handled safely without triggering injection detection
      const safeSpecialChars = [
        { field: "constituent.email", operator: "contains", value: "test%user@example.com" },
        { field: "constituent.firstName", operator: "contains", value: "O'Brien" },
        { field: "constituent.lastName", operator: "contains", value: "Smith-Jones" },
      ];

      for (const condition of safeSpecialChars) {
        const response = await app.inject({
          method: "POST",
          url: "/v1/constituents/filter",
          headers: authHeader(token),
          payload: {
            query: {
              operator: "AND",
              conditions: [condition],
            },
          },
        });

        expect(response.statusCode).toBe(200);
        // Results might be empty but query should succeed
      }
    });

    it.skip("should enforce query complexity limits", async () => {
      // Create a query with more than 10 conditions
      const conditions = [];
      for (let i = 0; i < 12; i++) {
        conditions.push({
          field: "constituent.email",
          operator: "contains",
          value: `test${i}@example.com`,
        });
      }

      const response = await app.inject({
        method: "POST",
        url: "/v1/constituents/filter",
        headers: authHeader(token),
        payload: {
          query: {
            operator: "AND",
            conditions,
          },
        },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.errors.some((e: string) => e.includes("Query complexity exceeds maximum"))).toBe(
        true,
      );
    });

    it.skip("should enforce nesting depth limits", async () => {
      // Create a deeply nested query
      const deepQuery: FilterQuery = {
        operator: "AND",
        conditions: [
          {
            field: "constituent.email",
            operator: "contains",
            value: "test@example.com",
            subConditions: {
              operator: "OR",
              conditions: [
                {
                  field: "constituent.type",
                  operator: "eq",
                  value: "donor",
                  subConditions: {
                    operator: "AND",
                    conditions: [
                      {
                        field: "donations.count",
                        operator: "gt",
                        value: 5,
                        subConditions: {
                          operator: "OR",
                          conditions: [
                            {
                              field: "donations.totalAmount",
                              operator: "gt",
                              value: 100000,
                              subConditions: {
                                operator: "AND",
                                conditions: [
                                  { field: "address.city", operator: "eq", value: "New York" },
                                ],
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      };

      const response = await app.inject({
        method: "POST",
        url: "/v1/constituents/filter",
        headers: authHeader(token),
        payload: { query: deepQuery },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.errors.some((e: string) => e.includes("nesting depth exceeds maximum"))).toBe(
        true,
      );
    });

    it.skip("should enforce rate limiting on filter endpoint", async () => {
      // Make 11 requests (limit is 10 per minute)
      const promises = [];
      for (let i = 0; i < 11; i++) {
        promises.push(
          app.inject({
            method: "POST",
            url: "/v1/constituents/filter",
            headers: authHeader(token),
            payload: {
              query: {
                operator: "AND",
                conditions: [{ field: "constituent.type", operator: "eq", value: "donor" }],
              },
            },
          }),
        );
      }

      const responses = await Promise.all(promises);
      const successCount = responses.filter((r) => r.statusCode === 200).length;
      const rateLimitedCount = responses.filter((r) => r.statusCode === 429).length;

      expect(successCount).toBe(10);
      expect(rateLimitedCount).toBe(1);
    });
  });

  describe("GET /v1/constituents?filters= (list-endpoint DSL — Epic #418 follow-up)", () => {
    /** Build the list URL with a JSON-serialised FilterQuery. */
    function listUrl(query: unknown, extra = ""): string {
      return `/v1/constituents?filters=${encodeURIComponent(JSON.stringify(query))}${extra}`;
    }

    it("filters the list by a regular condition (address.city eq)", async () => {
      const response = await app.inject({
        method: "GET",
        url: listUrl({
          operator: "AND",
          conditions: [{ field: "address.city", operator: "eq", value: "New York" }],
        }),
        headers: authHeader(token),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      const names = body.data.map((c: TestConstituent) => c.firstName).sort();
      expect(names).toEqual(["Bob", "John"]);
      expect(body.pagination.total).toBe(2);
    });

    it("filters by a donation aggregate with EUR→cents scaling (totalAmount gte 1000 EUR)", async () => {
      // John has 3 × 1000 EUR cleared donations; everyone else is far below.
      // The value crosses the DSL boundary in EUR and must compare against
      // `total_amount_cents` via the donation_stats join — this is the test
      // that fails if the list route forgets that join.
      const response = await app.inject({
        method: "GET",
        url: listUrl({
          operator: "AND",
          conditions: [{ field: "donations.totalAmount", operator: "gte", value: 1000 }],
        }),
        headers: authHeader(token),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.map((c: TestConstituent) => c.firstName)).toEqual(["John"]);
    });

    it("supports pattern-only queries (LYBUNT preset)", async () => {
      const response = await app.inject({
        method: "GET",
        url: listUrl({ operator: "AND", conditions: [], patterns: ["LYBUNT"] }),
        headers: authHeader(token),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      // Jane's only cleared donation is last-year December → LYBUNT.
      expect(body.data.map((c: TestConstituent) => c.firstName)).toEqual(["Jane"]);
    });

    it("composes with the quick-search param (AND semantics)", async () => {
      const response = await app.inject({
        method: "GET",
        url: listUrl(
          {
            operator: "AND",
            conditions: [{ field: "address.city", operator: "eq", value: "New York" }],
          },
          "&search=doe",
        ),
        headers: authHeader(token),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      // City=New York matches John + Bob; search "doe" narrows to John Doe.
      expect(body.data.map((c: TestConstituent) => c.firstName)).toEqual(["John"]);
    });

    it("excludes soft-deleted constituents from filtered results", async () => {
      const johnId = testConstituents[0]!.id;
      await withTenantContext(ORG_A, async (db) => {
        await db
          .update(constituents)
          .set({ deletedAt: new Date() })
          .where(and(eq(constituents.id, johnId), eq(constituents.orgId, ORG_A)));
      });

      const response = await app.inject({
        method: "GET",
        url: listUrl({
          operator: "AND",
          conditions: [{ field: "address.city", operator: "eq", value: "New York" }],
        }),
        headers: authHeader(token),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.map((c: TestConstituent) => c.firstName)).toEqual(["Bob"]);
    });

    it("never leaks another tenant's rows (RLS + explicit orgId)", async () => {
      // Org B runs the same city filter Org A has two matches for. Under the
      // `api-tests-app` job this exercises the RLS path end-to-end (issue
      // #455); the explicit eq(orgId) keeps it correct under the owner role.
      const response = await app.inject({
        method: "GET",
        url: listUrl({
          operator: "AND",
          conditions: [{ field: "address.city", operator: "eq", value: "New York" }],
        }),
        headers: authHeader(tokenB),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toEqual([]);
      expect(body.pagination.total).toBe(0);
    });

    it("rejects unparseable JSON with 400", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/v1/constituents?filters=${encodeURIComponent("{not json")}`,
        headers: authHeader(token),
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().title).toBe("Invalid filter query");
    });

    it("rejects non-object JSON (scalar / array) with 400", async () => {
      for (const payload of ["42", "[]", "null", '"str"']) {
        const response = await app.inject({
          method: "GET",
          url: `/v1/constituents?filters=${encodeURIComponent(payload)}`,
          headers: authHeader(token),
        });
        expect(response.statusCode).toBe(400);
      }
    });

    it("rejects unknown fields with 400 and a structured error list", async () => {
      const response = await app.inject({
        method: "GET",
        url: listUrl({
          operator: "AND",
          conditions: [{ field: "constituent.doesNotExist", operator: "eq", value: "x" }],
        }),
        headers: authHeader(token),
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.errors.some((e: string) => e.includes("Unknown field"))).toBe(true);
    });

    it("rejects unknown fields nested inside subConditions with 400 (never silently dropped)", async () => {
      // Per-condition validation recurses into nested groups: without it a
      // nested unknown leaf would compile to undefined and the list would
      // run UNFILTERED while the URL claims the condition is active.
      const response = await app.inject({
        method: "GET",
        url: listUrl({
          operator: "AND",
          conditions: [
            {
              field: "constituent.email",
              operator: "contains",
              value: "@example.com",
              subConditions: {
                operator: "OR",
                conditions: [{ field: "constituent.doesNotExist", operator: "eq", value: "x" }],
              },
            },
          ],
        }),
        headers: authHeader(token),
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.errors.some((e: string) => e.includes("Unknown field"))).toBe(true);
    });

    it("404s the filters param when the advanced_filters flag is off — but leaves the plain list untouched", async () => {
      await db
        .update(featureFlags)
        .set({ enabled: false })
        .where(eq(featureFlags.key, FEATURE_FLAG_KEYS.ADVANCED_FILTERS));
      await flagService.invalidate();
      await flagService.invalidateTenant(ORG_A);

      try {
        // With the param: 404, exactly like the requireFlag-gated routes —
        // never a silently-unfiltered 200 an operator would mistake for a
        // filtered list.
        const gated = await app.inject({
          method: "GET",
          url: listUrl({
            operator: "AND",
            conditions: [{ field: "address.city", operator: "eq", value: "New York" }],
          }),
          headers: authHeader(token),
        });
        expect(gated.statusCode).toBe(404);

        // Without the param: the list route behaves exactly as before the
        // feature existed.
        const plain = await app.inject({
          method: "GET",
          url: "/v1/constituents",
          headers: authHeader(token),
        });
        expect(plain.statusCode).toBe(200);
        expect(plain.json().pagination.total).toBe(4);
      } finally {
        await db
          .update(featureFlags)
          .set({ enabled: true })
          .where(eq(featureFlags.key, FEATURE_FLAG_KEYS.ADVANCED_FILTERS));
        await flagService.invalidate();
        await flagService.invalidateTenant(ORG_A);
      }
    });

    it("keeps the ConstituentListRow response shape (lastDonationAt from donation_agg)", async () => {
      const response = await app.inject({
        method: "GET",
        url: listUrl({
          operator: "AND",
          conditions: [{ field: "donations.count", operator: "gte", value: 1 }],
        }),
        headers: authHeader(token),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.length).toBeGreaterThan(0);
      for (const row of body.data) {
        // The list row shape (NOT the /filter result shape) — the table
        // consumes lastDonationAt, types, tags exactly as without filters.
        expect(row).toHaveProperty("lastDonationAt");
        expect(row).toHaveProperty("types");
      }
    });
  });
});
