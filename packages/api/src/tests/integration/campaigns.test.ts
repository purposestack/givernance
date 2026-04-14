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

let constituentIdA: string;

beforeAll(async () => {
  app = await createServer();
  await app.ready();

  // Ensure test tenants exist
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug) VALUES (${ORG_A}, 'Org A', 'test-org-a') ON CONFLICT (id) DO NOTHING`,
  );
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug) VALUES (${ORG_B}, 'Org B', 'test-org-b') ON CONFLICT (id) DO NOTHING`,
  );

  // Create a constituent for nominative campaign tests
  const tokenA = signToken(app);
  const res = await app.inject({
    method: "POST",
    url: "/v1/constituents?force=true",
    headers: authHeader(tokenA),
    payload: { firstName: "Campaign", lastName: "Donor", type: "donor" },
  });
  constituentIdA = res.json<{ data: { id: string } }>().data.id;
});

afterAll(async () => {
  await app.close();
});

// ─── Campaigns CRUD ────────────────────────────────────────────────────────

describe("Campaigns CRUD", () => {
  let campaignId: string;

  it("POST /v1/campaigns creates a nominative postal campaign", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: authHeader(token),
      payload: { name: "Spring Appeal 2026", type: "nominative_postal" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ data: { id: string; name: string; type: string; status: string } }>();
    expect(body.data.name).toBe("Spring Appeal 2026");
    expect(body.data.type).toBe("nominative_postal");
    expect(body.data.status).toBe("draft");
    campaignId = body.data.id;
  });

  it("POST /v1/campaigns creates a door_drop campaign", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: authHeader(token),
      payload: { name: "Door Drop Summer", type: "door_drop" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ data: { type: string } }>();
    expect(body.data.type).toBe("door_drop");
  });

  it("GET /v1/campaigns lists campaigns", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/campaigns",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: unknown[]; pagination: { total: number } }>();
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    expect(body.pagination.total).toBeGreaterThanOrEqual(2);
  });

  it("POST /v1/campaigns/:id/documents triggers document generation", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/documents`,
      headers: authHeader(token),
      payload: { constituentIds: [constituentIdA] },
    });

    expect(res.statusCode).toBe(202);
    const body = res.json<{ data: { campaignId: string; documentCount: number } }>();
    expect(body.data.campaignId).toBe(campaignId);
    expect(body.data.documentCount).toBe(1);
  });

  it("POST /v1/campaigns/:id/documents returns 404 for non-existent campaign", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/campaigns/00000000-0000-0000-0000-ffffffffffff/documents",
      headers: authHeader(token),
      payload: { constituentIds: [] },
    });

    expect(res.statusCode).toBe(404);
  });

  it("CampaignDocumentsRequested outbox event is emitted", async () => {
    const rows = await db.execute(
      sql`SELECT type, payload FROM outbox_events
          WHERE tenant_id = ${ORG_A} AND type = 'campaign.documents_requested'
          ORDER BY created_at DESC LIMIT 1`,
    );

    expect(rows.rows.length).toBe(1);
    expect((rows.rows[0] as { type: string }).type).toBe("campaign.documents_requested");
  });
});

// ─── Campaigns RLS Tenant Isolation ────────────────────────────────────────

describe("Campaigns RLS tenant isolation", () => {
  let campaignInA: string;

  beforeAll(async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: authHeader(tokenA),
      payload: { name: "RLS Test Campaign", type: "digital" },
    });
    campaignInA = res.json<{ data: { id: string } }>().data.id;
  });

  it("Tenant B list does not include Tenant A campaigns", async () => {
    const tokenB = signToken(app, { sub: USER_B, org_id: ORG_B, email: "user-b@example.org" });
    const res = await app.inject({
      method: "GET",
      url: "/v1/campaigns",
      headers: authHeader(tokenB),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { id: string }[] }>();
    const ids = body.data.map((c) => c.id);
    expect(ids).not.toContain(campaignInA);
  });

  it("Tenant B cannot trigger documents for Tenant A campaign", async () => {
    const tokenB = signToken(app, { sub: USER_B, org_id: ORG_B, email: "user-b@example.org" });
    const res = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignInA}/documents`,
      headers: authHeader(tokenB),
      payload: { constituentIds: [] },
    });

    expect(res.statusCode).toBe(404);
  });
});

// ─── Campaigns Unauthenticated Access ──────────────────────────────────────

describe("Campaigns unauthenticated access", () => {
  it("GET /v1/campaigns without token returns 401", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/campaigns" });
    expect(res.statusCode).toBe(401);
  });

  it("POST /v1/campaigns without token returns 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      payload: { name: "Test", type: "digital" },
    });
    expect(res.statusCode).toBe(401);
  });
});
