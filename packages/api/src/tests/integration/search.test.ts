/**
 * Global search integration tests (Epic #364, GLO-001).
 *
 * Coverage matrix:
 *   1. Off-state flag — `GET /v1/search` returns 404 when the flag is
 *      off, INCLUDING for unauthenticated callers (flag gate fires
 *      before auth — anti-disclosure).
 *   2. On-state flag — happy path returns grouped hits with the
 *      `{ data: { query, groups } }` envelope.
 *   3. RLS isolation — Tenant A's records never appear in Tenant B's
 *      search results, even when the literal query matches both.
 *   4. Query-injection safety — pg-flavoured payloads (NUL byte, SQL
 *      meta-characters, `to_tsquery` operators) don't crash and don't
 *      escape the parameter binder.
 *   5. Schema parity — the `productivity.command_palette` row matches
 *      `FEATURE_FLAG_REGISTRY` (drift guard).
 *   6. RFC 9457 body shape on the off-state 404.
 */

import { FEATURE_FLAG_KEYS, FEATURE_FLAG_REGISTRY } from "@givernance/shared/constants";
import { campaigns, constituents, donations, featureFlags } from "@givernance/shared/schema";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";
import { flagService } from "../../lib/flags/flag-service.js";
import { createServer } from "../../server.js";
import {
  authHeader,
  ensureTestTenants,
  ORG_A,
  ORG_B,
  signToken,
  signTokenB,
} from "../helpers/auth.js";

const FLAG_KEY = FEATURE_FLAG_KEYS.PRODUCTIVITY_COMMAND_PALETTE;

let app: FastifyInstance;

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();
});

afterAll(async () => {
  await db.update(featureFlags).set({ enabled: false }).where(eq(featureFlags.key, FLAG_KEY));
  await flagService.invalidate();
  await app.close();
});

beforeEach(async () => {
  // Clean only the rows this suite seeds — other suites share the
  // schema and may have their own fixtures live.
  await db.execute(sql`DELETE FROM donations WHERE payment_ref LIKE 'SEARCH-TEST-%'`);
  await db.execute(sql`DELETE FROM campaigns WHERE name LIKE 'SEARCH-TEST-%'`);
  await db.execute(sql`DELETE FROM constituents WHERE first_name LIKE 'SEARCH-TEST-%'`);
  await db.update(featureFlags).set({ enabled: false }).where(eq(featureFlags.key, FLAG_KEY));
  await flagService.invalidate();
});

afterEach(async () => {
  await db.update(featureFlags).set({ enabled: false }).where(eq(featureFlags.key, FLAG_KEY));
  await flagService.invalidate();
});

async function setFlag(enabled: boolean): Promise<void> {
  await db.update(featureFlags).set({ enabled }).where(eq(featureFlags.key, FLAG_KEY));
  await flagService.invalidate();
}

async function seedConstituent(
  orgId: string,
  firstName: string,
  lastName: string,
): Promise<string> {
  // owner-pool insert bypasses RLS so we can seed for any tenant.
  const id = crypto.randomUUID();
  await db
    .insert(constituents)
    .values({
      id,
      orgId,
      firstName,
      lastName,
      type: "donor",
    })
    .execute();
  return id;
}

async function seedCampaign(orgId: string, name: string): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .insert(campaigns)
    .values({
      id,
      orgId,
      name,
      type: "digital",
      status: "active",
    })
    .execute();
  return id;
}

async function seedDonation(
  orgId: string,
  constituentId: string,
  paymentRef: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .insert(donations)
    .values({
      id,
      orgId,
      constituentId,
      amountCents: 25_000,
      currency: "EUR",
      amountBaseCents: 25_000,
      paymentMethod: "manual",
      paymentRef,
      donatedAt: new Date("2026-02-25T10:00:00Z"),
    })
    .execute();
  return id;
}

// ─── 1. Off-state flag (anti-disclosure) ─────────────────────────────

describe("Search — off-state flag (anti-disclosure)", () => {
  it("returns 404 on GET /v1/search when flag is off (authenticated)", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/search?q=marie",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(404);
  });

  it("unauthenticated GET /v1/search also returns 404 (gate before auth)", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/search?q=marie" });
    expect(res.statusCode).toBe(404);
  });

  it("off-state 404 body conforms to RFC 9457 (status + title members)", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/search?q=marie",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(404);
    const body = res.json<{ status?: number; title?: string }>();
    expect(body.status).toBe(404);
    expect(body.title).toBe("Not Found");
  });
});

// ─── 2. Happy path ───────────────────────────────────────────────────

describe("Search — happy path", () => {
  beforeEach(async () => {
    await setFlag(true);
    // Use highly-unique fixture names so other test suites' constituents
    // (e.g. constituents.test.ts seeds "Marie" rows of its own) don't
    // crowd this query past the PER_GROUP_LIMIT=5 cap.
    const marie = await seedConstituent(ORG_A, "SEARCH-TEST-Marie", "Quotaxis");
    await seedConstituent(ORG_A, "SEARCH-TEST-Ahmed", "Benali");
    await seedCampaign(ORG_A, "SEARCH-TEST-SpringQuotaxis");
    await seedDonation(ORG_A, marie, "SEARCH-TEST-PAY-Quotaxis-001");
  });

  it("returns grouped hits matching the query", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/search?q=Quotaxis",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        query: string;
        groups: {
          constituents: Array<{ id: string; type: string; title: string; href: string }>;
          campaigns: Array<{ id: string; title: string }>;
          donations: Array<{ id: string; title: string }>;
        };
      };
    }>();

    expect(body.data.query).toBe("Quotaxis");
    expect(body.data.groups.constituents.length).toBeGreaterThanOrEqual(1);

    const marieHit = body.data.groups.constituents.find((h) => h.title.includes("Quotaxis"));
    expect(marieHit).toBeDefined();
    expect(marieHit?.type).toBe("constituent");
    expect(marieHit?.href).toMatch(/^\/constituents\//);

    // Donation joined via constituent name comes through.
    const donationHit = body.data.groups.donations.find((h) =>
      h.title.includes("SEARCH-TEST-PAY-Quotaxis-001"),
    );
    expect(donationHit).toBeDefined();
  });

  it("returns the campaign group when the campaign name matches", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/search?q=SpringQuotaxis",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: { groups: { campaigns: Array<{ title: string }> } };
    }>();
    const hit = body.data.groups.campaigns.find((h) => h.title.includes("SpringQuotaxis"));
    expect(hit).toBeDefined();
  });

  it("returns empty groups when the query has no matches", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/search?q=zzznomatchzzz",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        groups: {
          constituents: unknown[];
          campaigns: unknown[];
          donations: unknown[];
        };
      };
    }>();
    expect(body.data.groups.constituents).toEqual([]);
    expect(body.data.groups.campaigns).toEqual([]);
    expect(body.data.groups.donations).toEqual([]);
  });

  it("rejects an empty `q` with a 400", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/search?q=",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a missing `q` with a 400", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/search",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(400);
  });
});

// ─── 3. RLS isolation ────────────────────────────────────────────────

describe("Search — RLS isolation across tenants", () => {
  it("Tenant B cannot see Tenant A constituents matching the same query", async () => {
    await setFlag(true);
    // Both tenants own a "SEARCH-TEST-Camille". RLS must not leak A's
    // row to B and vice versa.
    await seedConstituent(ORG_A, "SEARCH-TEST-Camille", "AlphaOnly");
    await seedConstituent(ORG_B, "SEARCH-TEST-Camille", "BravoOnly");

    const tokenB = signTokenB(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/search?q=Camille",
      headers: authHeader(tokenB),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: { groups: { constituents: Array<{ title: string }> } };
    }>();
    // Bravo (B's row) is allowed; Alpha (A's row) MUST be absent.
    const titles = body.data.groups.constituents.map((h) => h.title);
    expect(titles.some((t) => t.includes("BravoOnly"))).toBe(true);
    expect(titles.some((t) => t.includes("AlphaOnly"))).toBe(false);
  });

  it("Tenant A's campaigns are not visible to Tenant B", async () => {
    await setFlag(true);
    await seedCampaign(ORG_A, "SEARCH-TEST-AlphaSecretCampaign");

    const tokenB = signTokenB(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/search?q=AlphaSecret",
      headers: authHeader(tokenB),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { groups: { campaigns: Array<{ title: string }> } } }>();
    expect(body.data.groups.campaigns).toEqual([]);
  });
});

// ─── 4. Query-injection safety ───────────────────────────────────────

describe("Search — query-injection safety", () => {
  beforeEach(async () => {
    await setFlag(true);
    await seedConstituent(ORG_A, "SEARCH-TEST-Probe-Marie", "Fontaine");
  });

  it("a NUL byte in `q` is stripped without crashing pg", async () => {
    const token = signToken(app);
    // NUL byte ( ) — pg rejects this if it ever reaches the binder.
    // Our normaliser strips C0 chars; this asserts the path is clean.
    const res = await app.inject({
      method: "GET",
      url: `/v1/search?q=${encodeURIComponent("Mar ie")}`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
  });

  it("tsquery meta-operators are accepted via plainto_tsquery (no syntax errors)", async () => {
    const token = signToken(app);
    // `plainto_tsquery` quotes operators as plain words, so `&`, `|`,
    // `!`, `()` are not parsed as boolean operators and do not crash.
    const probes = ["marie & fontaine", "marie | x", "!marie", "marie:*", "(marie)"];
    for (const probe of probes) {
      const res = await app.inject({
        method: "GET",
        url: `/v1/search?q=${encodeURIComponent(probe)}`,
        headers: authHeader(token),
      });
      expect(res.statusCode).toBe(200);
    }
  });

  it("a SQL-meta-character query does not cause a 500", async () => {
    const token = signToken(app);
    // Classic injection probes — all should be bound as parameters.
    const probes = ["'; DROP TABLE constituents; --", '"; SELECT * FROM users; --', "%' OR 1=1 --"];
    for (const probe of probes) {
      const res = await app.inject({
        method: "GET",
        url: `/v1/search?q=${encodeURIComponent(probe)}`,
        headers: authHeader(token),
      });
      // 200 (no hits, or whatever the literal happens to match) — never 500.
      expect(res.statusCode).toBe(200);
    }

    // Verify the constituent we seeded still exists (table NOT dropped).
    const survived = await db.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count FROM constituents WHERE first_name = 'SEARCH-TEST-Probe-Marie'
    `);
    expect(Number(survived.rows[0]?.count ?? "0")).toBeGreaterThanOrEqual(1);
  });
});

// ─── 5. Registry parity ──────────────────────────────────────────────

describe("Search — feature-flag registry parity", () => {
  it("DB row for productivity.command_palette matches FEATURE_FLAG_REGISTRY", async () => {
    const row = await db.query.featureFlags.findFirst({
      where: eq(featureFlags.key, FLAG_KEY),
    });
    expect(row).toBeDefined();

    const expected = FEATURE_FLAG_REGISTRY.find((r) => r.key === FLAG_KEY);
    expect(expected).toBeDefined();
    if (!row || !expected) return;

    expect(row.label).toBe(expected.label);
    expect(row.description).toBe(expected.description);
    expect(row.scope).toBe(expected.scope);
    expect(row.tenantOverrideAllowed).toBe(expected.tenantOverrideAllowed);
    expect(row.public).toBe(expected.public);
  });
});
