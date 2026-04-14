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
      url: "/v1/constituents",
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
        url: "/v1/constituents",
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

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { lastName: string }[]; pagination: { total: number } }>();
    expect(body.data.length).toBe(2);
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

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: unknown[] }>();
    expect(body.data.length).toBe(1);
  });

  it("filter by type returns only matching type", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents?type=volunteer",
      headers: authHeader(tokenA),
    });

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
      url: "/v1/constituents",
      headers: authHeader(tokenA),
      payload: { firstName: "TenantA", lastName: "Only", type: "donor" },
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
