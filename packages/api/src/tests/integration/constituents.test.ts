import { donations } from "@givernance/shared/schema";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";
import { createServer } from "../../server.js";

let app: FastifyInstance;

const ORG_A = "00000000-0000-0000-0000-000000000001";
const ORG_B = "00000000-0000-0000-0000-000000000002";
const USER_A = "00000000-0000-0000-0000-000000000099";
const USER_B = "00000000-0000-0000-0000-000000000098";

function signToken(app: FastifyInstance, claims: Record<string, unknown> = {}) {
  return app.jwt.sign({
    sub: USER_A,
    org_id: ORG_A,
    realm_access: { roles: ["admin"] },
    email: "user-a@example.org",
    role: "org_admin",
    ...claims,
  });
}

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  app = await createServer();
  await app.ready();

  // Ensure test tenants exist with specific IDs (upsert via ON CONFLICT)
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug) VALUES (${ORG_A}, 'Org A', 'test-org-a') ON CONFLICT (id) DO NOTHING`,
  );
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug) VALUES (${ORG_B}, 'Org B', 'test-org-b') ON CONFLICT (id) DO NOTHING`,
  );
});

afterAll(async () => {
  await app.close();
});

// ─── CRUD Operations ────────────────────────────────────────────────────────

describe("Constituents CRUD", () => {
  let constituentId: string;

  it("POST /v1/constituents creates a constituent", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(tokenA),
      payload: {
        firstName: "Alice",
        lastName: "Dupont",
        email: "alice@example.org",
        type: "donor",
        tags: ["major-donor", "annual"],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ data: { id: string; firstName: string } }>();
    expect(body.data).toHaveProperty("id");
    expect(body.data.firstName).toBe("Alice");
    constituentId = body.data.id;
  });

  it("GET /v1/constituents/:id returns the constituent with activities stub", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/constituents/${constituentId}`,
      headers: authHeader(tokenA),
    });

    if (res.statusCode !== 200) console.error("TEST FAILED RESPONSE:", res.json());
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { id: string; activities: unknown[] } }>();
    expect(body.data.id).toBe(constituentId);
    expect(body.data.activities).toEqual([]);
  });

  it("PUT /v1/constituents/:id updates the constituent", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "PUT",
      url: `/v1/constituents/${constituentId}`,
      headers: authHeader(tokenA),
      payload: { lastName: "Martin" },
    });

    if (res.statusCode !== 200) console.error("TEST FAILED RESPONSE:", res.json());
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { lastName: string } }>();
    expect(body.data.lastName).toBe("Martin");
  });

  it("GET /v1/constituents/:id returns 404 for non-existent ID", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents/00000000-0000-0000-0000-ffffffffffff",
      headers: authHeader(tokenA),
    });

    expect(res.statusCode).toBe(404);
  });

  it("PUT /v1/constituents/:id returns 404 for non-existent ID", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "PUT",
      url: "/v1/constituents/00000000-0000-0000-0000-ffffffffffff",
      headers: authHeader(tokenA),
      payload: { firstName: "Ghost" },
    });

    expect(res.statusCode).toBe(404);
  });

  it("DELETE /v1/constituents/:id soft-deletes the constituent", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/constituents/${constituentId}`,
      headers: authHeader(tokenA),
    });

    if (res.statusCode !== 200) console.error("TEST FAILED RESPONSE:", res.json());
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { deletedAt: string } }>();
    expect(body.data.deletedAt).toBeTruthy();
  });

  it("GET /v1/constituents/:id returns 404 after soft-delete", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/constituents/${constituentId}`,
      headers: authHeader(tokenA),
    });

    expect(res.statusCode).toBe(404);
  });

  it("DELETE /v1/constituents/:id returns 404 for already-deleted constituent", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/constituents/${constituentId}`,
      headers: authHeader(tokenA),
    });

    expect(res.statusCode).toBe(404);
  });
});

// ─── Search and Filtering ───────────────────────────────────────────────────

describe("Constituents search and filtering", () => {
  beforeAll(async () => {
    const tokenA = signToken(app);
    // Create a few constituents for searching
    const entries = [
      {
        firstName: "Marie",
        lastName: "Curie",
        email: "marie@science.org",
        type: "donor",
        tags: ["vip"],
      },
      {
        firstName: "Pierre",
        lastName: "Curie",
        email: "pierre@science.org",
        type: "volunteer",
        tags: ["vip", "board"],
      },
      {
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@tech.org",
        type: "member",
        tags: ["board"],
      },
    ];

    for (const entry of entries) {
      await app.inject({
        method: "POST",
        url: "/v1/constituents?force=true",
        headers: authHeader(tokenA),
        payload: entry,
      });
    }
  });

  it("search by name returns matching constituents", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents?search=Curie",
      headers: authHeader(tokenA),
    });

    if (res.statusCode !== 200) console.error("TEST FAILED RESPONSE:", res.json());
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { lastName: string }[]; pagination: { total: number } }>();
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    for (const c of body.data) {
      expect(c.lastName).toBe("Curie");
    }
  });

  it("search by email returns matching constituents", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents?search=ada@tech",
      headers: authHeader(tokenA),
    });

    if (res.statusCode !== 200) console.error("TEST FAILED RESPONSE:", res.json());
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: unknown[] }>();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("filter by type returns only matching type", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents?type=volunteer",
      headers: authHeader(tokenA),
    });

    if (res.statusCode !== 200) console.error("TEST FAILED RESPONSE:", res.json());
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { type: string }[] }>();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    for (const c of body.data) {
      expect(c.type).toBe("volunteer");
    }
  });

  it("filter by tags returns constituents with matching tags", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents?tags=board",
      headers: authHeader(tokenA),
    });

    if (res.statusCode !== 200) console.error("TEST FAILED RESPONSE:", res.json());
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { tags: string[] }[] }>();
    expect(body.data.length).toBeGreaterThanOrEqual(2);
  });

  it("soft-deleted constituents are excluded by default", async () => {
    const tokenA = signToken(app);
    // The constituent deleted in the CRUD tests above should NOT appear
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents",
      headers: authHeader(tokenA),
    });

    if (res.statusCode !== 200) console.error("TEST FAILED RESPONSE:", res.json());
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { deletedAt: string | null }[] }>();
    for (const c of body.data) {
      expect(c.deletedAt).toBeNull();
    }
  });
});

// ─── RLS Tenant Isolation ───────────────────────────────────────────────────

describe("Constituents RLS tenant isolation", () => {
  let constituentInA: string;

  beforeAll(async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(tokenA),
      payload: { firstName: "TenantAIsolation", lastName: "Only", type: "donor" },
    });
    constituentInA = res.json<{ data: { id: string } }>().data.id;
  });

  it("Tenant B cannot GET a constituent from Tenant A", async () => {
    const tokenB = signToken(app, { sub: USER_B, org_id: ORG_B, email: "user-b@example.org" });
    const res = await app.inject({
      method: "GET",
      url: `/v1/constituents/${constituentInA}`,
      headers: authHeader(tokenB),
    });

    expect(res.statusCode).toBe(404);
  });

  it("Tenant B cannot PUT a constituent from Tenant A", async () => {
    const tokenB = signToken(app, { sub: USER_B, org_id: ORG_B, email: "user-b@example.org" });
    const res = await app.inject({
      method: "PUT",
      url: `/v1/constituents/${constituentInA}`,
      headers: authHeader(tokenB),
      payload: { firstName: "Hacked" },
    });

    expect(res.statusCode).toBe(404);
  });

  it("Tenant B cannot DELETE a constituent from Tenant A", async () => {
    const tokenB = signToken(app, { sub: USER_B, org_id: ORG_B, email: "user-b@example.org" });
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/constituents/${constituentInA}`,
      headers: authHeader(tokenB),
    });

    expect(res.statusCode).toBe(404);
  });

  it("Tenant B list does not include Tenant A constituents", async () => {
    const tokenB = signToken(app, { sub: USER_B, org_id: ORG_B, email: "user-b@example.org" });
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents",
      headers: authHeader(tokenB),
    });

    if (res.statusCode !== 200) console.error("TEST FAILED RESPONSE:", res.json());
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { id: string }[] }>();
    const ids = body.data.map((c) => c.id);
    expect(ids).not.toContain(constituentInA);
  });
});

// ─── Unauthenticated Access ─────────────────────────────────────────────────

describe("Constituents unauthenticated access", () => {
  it("GET /v1/constituents/:id without token returns 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents/00000000-0000-0000-0000-000000000001",
    });
    expect(res.statusCode).toBe(401);
  });

  it("PUT /v1/constituents/:id without token returns 401", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/v1/constituents/00000000-0000-0000-0000-000000000001",
      payload: { firstName: "Test" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("DELETE /v1/constituents/:id without token returns 401", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/constituents/00000000-0000-0000-0000-000000000001",
    });
    expect(res.statusCode).toBe(401);
  });
});

// ─── Duplicate Detection ──────────────────────────────────────────────────────

describe("Constituents duplicate detection", () => {
  // Use a unique name to avoid conflicts from accumulated test data
  const uniqueSuffix = Date.now().toString(36);
  const dedupFirst = `Zdravko${uniqueSuffix}`;
  const dedupLast = `Petrovic${uniqueSuffix}`;
  const dedupEmail = `zdravko.${uniqueSuffix}@example.org`;
  let dedupId: string;

  beforeAll(async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(tokenA),
      payload: {
        firstName: dedupFirst,
        lastName: dedupLast,
        email: dedupEmail,
        type: "donor",
      },
    });
    dedupId = res.json<{ data: { id: string } }>().data.id;
  });

  it("GET /v1/constituents/duplicates/search finds similar names", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/constituents/duplicates/search?firstName=${dedupFirst}&lastName=${dedupLast}`,
      headers: authHeader(tokenA),
    });

    if (res.statusCode !== 200) console.error("TEST FAILED RESPONSE:", res.json());
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { id: string; score: number }[] }>();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    const match = body.data.find((d) => d.id === dedupId);
    expect(match).toBeTruthy();
    expect(match?.score).toBeGreaterThanOrEqual(0.3);
  });

  it("GET /v1/constituents/duplicates/search finds exact email match", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/constituents/duplicates/search?firstName=Z&lastName=P&email=${dedupEmail}`,
      headers: authHeader(tokenA),
    });

    if (res.statusCode !== 200) console.error("TEST FAILED RESPONSE:", res.json());
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { id: string; score: number }[] }>();
    const match = body.data.find((d) => d.id === dedupId);
    expect(match).toBeTruthy();
  });

  it("POST /v1/constituents returns 409 when duplicate detected", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents",
      headers: authHeader(tokenA),
      payload: {
        firstName: dedupFirst,
        lastName: dedupLast,
        email: dedupEmail,
        type: "donor",
      },
    });

    if (res.statusCode !== 409) console.error("TEST FAILED RESPONSE 409:", res.json());
    expect(res.statusCode).toBe(409);
    const body = res.json<{ duplicates: { id: string }[] }>();
    expect(body.duplicates.length).toBeGreaterThanOrEqual(1);
  });

  it("POST /v1/constituents?force=true bypasses duplicate check", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(tokenA),
      payload: {
        firstName: dedupFirst,
        lastName: dedupLast,
        email: `force.${uniqueSuffix}@example.org`,
        type: "donor",
      },
    });

    expect(res.statusCode).toBe(201);
  });
});

// ─── Merge ────────────────────────────────────────────────────────────────────

describe("Constituents merge", () => {
  let primaryId: string;
  let duplicateId: string;
  let donationId: string;

  beforeAll(async () => {
    const tokenA = signToken(app);

    // Create primary constituent (has phone, no email)
    const res1 = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(tokenA),
      payload: {
        firstName: "Marie",
        lastName: "Mergeable",
        phone: "+33123456789",
        type: "donor",
        tags: ["annual"],
      },
    });
    primaryId = res1.json<{ data: { id: string } }>().data.id;

    // Create duplicate constituent (has email, no phone)
    const res2 = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(tokenA),
      payload: {
        firstName: "Marie",
        lastName: "Mergeable",
        email: "marie@merge.org",
        type: "donor",
        tags: ["vip"],
      },
    });
    duplicateId = res2.json<{ data: { id: string } }>().data.id;

    // Create a donation linked to the duplicate
    await db.execute(sql`SELECT set_config('app.current_org_id', ${ORG_A}, false)`);
    const [don] = await db
      .insert(donations)
      .values({
        orgId: ORG_A,
        constituentId: duplicateId,
        amountCents: 5000,
        currency: "EUR",
      })
      .returning();
    // biome-ignore lint/style/noNonNullAssertion: test setup — insert always returns a row
    donationId = don!.id;
  });

  it("POST /v1/constituents/:id/merge merges duplicate into primary", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: `/v1/constituents/${primaryId}/merge`,
      headers: authHeader(tokenA),
      payload: { targetId: duplicateId },
    });

    if (res.statusCode !== 200) console.error("TEST FAILED RESPONSE:", res.json());
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { merged: boolean } }>().data.merged).toBe(true);
  });

  it("primary constituent has merged fields from duplicate", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/constituents/${primaryId}`,
      headers: authHeader(tokenA),
    });

    if (res.statusCode !== 200) console.error("TEST FAILED RESPONSE:", res.json());
    expect(res.statusCode).toBe(200);
    const data = res.json<{
      data: { email: string; phone: string; tags: string[] };
    }>().data;
    // email was null on primary, should be filled from duplicate
    expect(data.email).toBe("marie@merge.org");
    // phone was already on primary, should remain
    expect(data.phone).toBe("+33123456789");
    // tags should be merged (union)
    expect(data.tags).toContain("annual");
    expect(data.tags).toContain("vip");
  });

  it("duplicate constituent is soft-deleted after merge", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/constituents/${duplicateId}`,
      headers: authHeader(tokenA),
    });

    expect(res.statusCode).toBe(404);
  });

  it("donations are moved to primary constituent", async () => {
    // Query directly to verify donation was reassigned
    await db.execute(sql`SELECT set_config('app.current_org_id', ${ORG_A}, false)`);
    const rows = await db.select().from(donations).where(sql`id = ${donationId}`);

    expect(rows.length).toBe(1);
    // biome-ignore lint/style/noNonNullAssertion: asserted rows.length === 1 above
    expect(rows[0]!.constituentId).toBe(primaryId);
  });

  it("outbox events are emitted for merge", async () => {
    const rows = await db.execute(
      sql`SELECT type, payload FROM outbox_events
          WHERE tenant_id = ${ORG_A}
            AND type IN ('constituent.merged', 'constituent.deleted')
          ORDER BY created_at DESC LIMIT 2`,
    );

    const types = rows.rows.map((r) => (r as { type: string }).type);
    expect(types).toContain("constituent.merged");
    expect(types).toContain("constituent.deleted");
  });

  it("returns 400 when merging a constituent into itself", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: `/v1/constituents/${primaryId}/merge`,
      headers: authHeader(tokenA),
      payload: { targetId: primaryId },
    });

    expect(res.statusCode).toBe(400);
  });

  it("returns 404 when one of the constituents does not exist", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: `/v1/constituents/${primaryId}/merge`,
      headers: authHeader(tokenA),
      payload: { targetId: "00000000-0000-0000-0000-ffffffffffff" },
    });

    expect(res.statusCode).toBe(404);
  });
});

// ─── Merge RLS Isolation ──────────────────────────────────────────────────────

describe("Constituents merge RLS isolation", () => {
  let tenantAConstituentId: string;
  let tenantBConstituentId: string;

  beforeAll(async () => {
    const tokenA = signToken(app);
    const res1 = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(tokenA),
      payload: { firstName: "RLS", lastName: "MergeA", type: "donor" },
    });
    tenantAConstituentId = res1.json<{ data: { id: string } }>().data.id;

    const tokenB = signToken(app, { sub: USER_B, org_id: ORG_B, email: "user-b@example.org" });
    const res2 = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(tokenB),
      payload: { firstName: "RLS", lastName: "MergeB", type: "donor" },
    });
    tenantBConstituentId = res2.json<{ data: { id: string } }>().data.id;
  });

  it("Tenant B cannot merge Tenant A constituents", async () => {
    const tokenB = signToken(app, { sub: USER_B, org_id: ORG_B, email: "user-b@example.org" });
    const res = await app.inject({
      method: "POST",
      url: `/v1/constituents/${tenantAConstituentId}/merge`,
      headers: authHeader(tokenB),
      payload: { targetId: tenantBConstituentId },
    });

    // Should 404 because tenant B cannot see tenant A's constituent
    expect(res.statusCode).toBe(404);
  });
});
