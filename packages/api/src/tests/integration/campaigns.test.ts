import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";
import { createServer } from "../../server.js";
import { authHeader, ensureTestTenants, ORG_A, signToken, signTokenB } from "../helpers/auth.js";

let app: FastifyInstance;

let constituentIdA: string;

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();

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

  it("POST /v1/campaigns creates a campaign with parentId and costCents", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: authHeader(token),
      payload: { name: "Sub-Campaign", type: "digital", parentId: campaignId, costCents: 50000 },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{
      data: { parentId: string; costCents: number };
    }>();
    expect(body.data.parentId).toBe(campaignId);
    expect(body.data.costCents).toBe(50000);
  });

  it("POST /v1/campaigns rejects non-existent parent UUID", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: authHeader(token),
      payload: {
        name: "Bad Parent",
        type: "digital",
        parentId: "00000000-0000-0000-0000-ffffffffffff",
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ detail: string }>();
    expect(body.detail).toContain("Parent campaign not found");
  });

  it("POST /v1/campaigns rejects cross-tenant parent", async () => {
    // Create a campaign in Org B
    const tokenB = signTokenB(app);
    const orgBRes = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: authHeader(tokenB),
      payload: { name: "Org B Campaign", type: "digital" },
    });
    const orgBCampaignId = orgBRes.json<{ data: { id: string } }>().data.id;

    // Try to create campaign in Org A with Org B's campaign as parent
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: authHeader(tokenA),
      payload: { name: "Cross Tenant Child", type: "digital", parentId: orgBCampaignId },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ detail: string }>();
    expect(body.detail).toContain("Parent campaign not found");
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

  it("GET /v1/campaigns/:id returns a single campaign", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${campaignId}`,
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { id: string; name: string } }>();
    expect(body.data.id).toBe(campaignId);
    expect(body.data.name).toBe("Spring Appeal 2026");
  });

  it("GET /v1/campaigns/:id returns 404 for non-existent campaign", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/campaigns/00000000-0000-0000-0000-ffffffffffff",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(404);
  });

  it("PATCH /v1/campaigns/:id updates a campaign", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/campaigns/${campaignId}`,
      headers: authHeader(token),
      payload: { name: "Spring Appeal 2026 Updated", costCents: 25000 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { name: string; costCents: number } }>();
    expect(body.data.name).toBe("Spring Appeal 2026 Updated");
    expect(body.data.costCents).toBe(25000);
  });

  it("PATCH /v1/campaigns/:id returns 404 for non-existent campaign", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/campaigns/00000000-0000-0000-0000-ffffffffffff",
      headers: authHeader(token),
      payload: { name: "Nope" },
    });

    expect(res.statusCode).toBe(404);
  });

  it("PATCH /v1/campaigns/:id rejects self-parent", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/campaigns/${campaignId}`,
      headers: authHeader(token),
      payload: { parentId: campaignId },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ detail: string }>();
    expect(body.detail).toContain("its own parent");
  });

  it("POST /v1/campaigns/:id/close closes a campaign", async () => {
    // Create a campaign to close
    const token = signToken(app);
    const createRes = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: authHeader(token),
      payload: { name: "To Close", type: "digital" },
    });
    const toCloseId = createRes.json<{ data: { id: string } }>().data.id;

    const res = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${toCloseId}/close`,
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { id: string; status: string } }>();
    expect(body.data.status).toBe("closed");
  });

  it("POST /v1/campaigns/:id/close returns 404 for non-existent campaign", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/campaigns/00000000-0000-0000-0000-ffffffffffff/close",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(404);
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

  it("POST /v1/campaigns/:id/documents returns 400 for invalid UUID", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/campaigns/not-a-valid-uuid/documents",
      headers: authHeader(token),
      payload: { constituentIds: [] },
    });

    expect(res.statusCode).toBe(400);
  });
});

// ─── Soft-delete visibility ──────────────────────────────────────────────────

describe("Closed campaign visibility", () => {
  it("GET /v1/campaigns/:id returns a closed campaign with status 'closed'", async () => {
    const token = signToken(app);

    // Create and close a campaign
    const createRes = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: authHeader(token),
      payload: { name: "Soft Delete Test", type: "digital" },
    });
    const id = createRes.json<{ data: { id: string } }>().data.id;

    await app.inject({
      method: "POST",
      url: `/v1/campaigns/${id}/close`,
      headers: authHeader(token),
    });

    // Verify it's still visible via GET
    const getRes = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${id}`,
      headers: authHeader(token),
    });

    expect(getRes.statusCode).toBe(200);
    const body = getRes.json<{ data: { id: string; status: string } }>();
    expect(body.data.id).toBe(id);
    expect(body.data.status).toBe("closed");
  });
});

// ─── Parent ID Validation ───────────────────────────────────────────────────

describe("Parent ID validation", () => {
  it("PATCH rejects multi-level cycle (A -> B -> A)", async () => {
    const token = signToken(app);

    // Create campaign A
    const aRes = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: authHeader(token),
      payload: { name: "Cycle A", type: "digital" },
    });
    const aId = aRes.json<{ data: { id: string } }>().data.id;

    // Create campaign B with parent A
    const bRes = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: authHeader(token),
      payload: { name: "Cycle B", type: "digital", parentId: aId },
    });
    const bId = bRes.json<{ data: { id: string } }>().data.id;

    // Try to set A's parent to B — should fail (A -> B -> A cycle)
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/campaigns/${aId}`,
      headers: authHeader(token),
      payload: { parentId: bId },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ detail: string }>();
    expect(body.detail).toContain("cycle");
  });

  it("PATCH rejects cross-tenant parent", async () => {
    const tokenA = signToken(app);
    const tokenB = signTokenB(app);

    // Create campaign in Org A
    const aRes = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: authHeader(tokenA),
      payload: { name: "Org A for cross-tenant", type: "digital" },
    });
    const aId = aRes.json<{ data: { id: string } }>().data.id;

    // Create campaign in Org B
    const bRes = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: authHeader(tokenB),
      payload: { name: "Org B for cross-tenant", type: "digital" },
    });
    const bId = bRes.json<{ data: { id: string } }>().data.id;

    // Try to set Org A campaign's parent to Org B campaign
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/campaigns/${aId}`,
      headers: authHeader(tokenA),
      payload: { parentId: bId },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ detail: string }>();
    expect(body.detail).toContain("Parent campaign not found");
  });

  it("PATCH rejects non-existent parent UUID", async () => {
    const token = signToken(app);

    const createRes = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: authHeader(token),
      payload: { name: "Bad Parent Target", type: "digital" },
    });
    const id = createRes.json<{ data: { id: string } }>().data.id;

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/campaigns/${id}`,
      headers: authHeader(token),
      payload: { parentId: "00000000-0000-0000-0000-ffffffffffff" },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ detail: string }>();
    expect(body.detail).toContain("Parent campaign not found");
  });
});

// ─── Outbox Events ──────────────────────────────────────────────────────────

describe("Outbox domain events", () => {
  it("campaign.created event is emitted on POST /v1/campaigns", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: authHeader(token),
      payload: { name: "Outbox Created Test", type: "digital" },
    });
    const campaignId = res.json<{ data: { id: string } }>().data.id;

    const rows = await db.execute(
      sql`SELECT type, payload FROM outbox_events
          WHERE tenant_id = ${ORG_A} AND type = 'campaign.created'
          AND (payload->>'campaignId') = ${campaignId}
          ORDER BY created_at DESC LIMIT 1`,
    );

    expect(rows.rows.length).toBe(1);
    expect((rows.rows[0] as { type: string }).type).toBe("campaign.created");
  });

  it("campaign.closed event is emitted on POST /v1/campaigns/:id/close", async () => {
    const token = signToken(app);

    // Create and close
    const createRes = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: authHeader(token),
      payload: { name: "Outbox Closed Test", type: "digital" },
    });
    const campaignId = createRes.json<{ data: { id: string } }>().data.id;

    await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/close`,
      headers: authHeader(token),
    });

    const rows = await db.execute(
      sql`SELECT type, payload FROM outbox_events
          WHERE tenant_id = ${ORG_A} AND type = 'campaign.closed'
          AND (payload->>'campaignId') = ${campaignId}
          ORDER BY created_at DESC LIMIT 1`,
    );

    expect(rows.rows.length).toBe(1);
    expect((rows.rows[0] as { type: string }).type).toBe("campaign.closed");
  });

  it("campaign.updated event is emitted on PATCH", async () => {
    const token = signToken(app);

    const createRes = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: authHeader(token),
      payload: { name: "Outbox Update Test", type: "digital" },
    });
    const campaignId = createRes.json<{ data: { id: string } }>().data.id;

    await app.inject({
      method: "PATCH",
      url: `/v1/campaigns/${campaignId}`,
      headers: authHeader(token),
      payload: { name: "Outbox Update Test Renamed" },
    });

    const rows = await db.execute(
      sql`SELECT type, payload FROM outbox_events
          WHERE tenant_id = ${ORG_A} AND type = 'campaign.updated'
          AND (payload->>'campaignId') = ${campaignId}
          ORDER BY created_at DESC LIMIT 1`,
    );

    expect(rows.rows.length).toBe(1);
    expect((rows.rows[0] as { type: string }).type).toBe("campaign.updated");
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

// ─── Pagination ─────────────────────────────────────────────────────────────

describe("Campaign pagination", () => {
  it("GET /v1/campaigns respects limit and offset via page/perPage", async () => {
    const token = signToken(app);

    // Request page 1 with perPage=2
    const res = await app.inject({
      method: "GET",
      url: "/v1/campaigns?perPage=2&page=1",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: unknown[];
      pagination: { page: number; perPage: number; total: number; totalPages: number };
    }>();
    expect(body.data.length).toBeLessThanOrEqual(2);
    expect(body.pagination.page).toBe(1);
    expect(body.pagination.perPage).toBe(2);
    expect(body.pagination.totalPages).toBeGreaterThanOrEqual(1);
  });

  it("GET /v1/campaigns page overflow returns empty data", async () => {
    const token = signToken(app);

    const res = await app.inject({
      method: "GET",
      url: "/v1/campaigns?page=9999&perPage=10",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: unknown[]; pagination: { page: number; total: number } }>();
    expect(body.data.length).toBe(0);
    expect(body.pagination.page).toBe(9999);
  });
});

// ─── Campaign Stats & ROI ─────────────────────────────────────────────────

describe("Campaign Stats & ROI", () => {
  let statsCampaignId: string;

  beforeAll(async () => {
    const token = signToken(app);

    // Create campaign with cost
    const campaignRes = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: authHeader(token),
      payload: { name: "Stats Campaign", type: "digital", costCents: 10000 },
    });
    statsCampaignId = campaignRes.json<{ data: { id: string } }>().data.id;

    // Create donations linked to this campaign
    await app.inject({
      method: "POST",
      url: "/v1/donations",
      headers: authHeader(token),
      payload: {
        constituentId: constituentIdA,
        amountCents: 5000,
        currency: "EUR",
        campaignId: statsCampaignId,
      },
    });
    await app.inject({
      method: "POST",
      url: "/v1/donations",
      headers: authHeader(token),
      payload: {
        constituentId: constituentIdA,
        amountCents: 15000,
        currency: "EUR",
        campaignId: statsCampaignId,
      },
    });
  });

  it("GET /v1/campaigns/:id/stats returns campaign statistics", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${statsCampaignId}/stats`,
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        campaignId: string;
        totalRaisedCents: number;
        donationCount: number;
        uniqueDonors: number;
      };
    }>();
    expect(body.data.campaignId).toBe(statsCampaignId);
    expect(body.data.totalRaisedCents).toBe(20000);
    expect(body.data.donationCount).toBe(2);
    expect(body.data.uniqueDonors).toBe(1);
  });

  it("GET /v1/campaigns/:id/stats returns 404 for non-existent campaign", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/campaigns/00000000-0000-0000-0000-ffffffffffff/stats",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(404);
  });

  it("GET /v1/campaigns/:id/roi returns campaign ROI", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${statsCampaignId}/roi`,
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: { campaignId: string; totalRaisedCents: number; costCents: number; roi: number };
    }>();
    expect(body.data.campaignId).toBe(statsCampaignId);
    expect(body.data.totalRaisedCents).toBe(20000);
    expect(body.data.costCents).toBe(10000);
    // ROI = (20000 - 10000) / 10000 = 1.0
    expect(body.data.roi).toBe(1.0);
  });

  it("GET /v1/campaigns/:id/roi returns null ROI and null costCents when no cost set", async () => {
    const token = signToken(app);

    // Create campaign without cost
    const createRes = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: authHeader(token),
      payload: { name: "No Cost Campaign", type: "digital" },
    });
    const noCostId = createRes.json<{ data: { id: string } }>().data.id;

    const res = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${noCostId}/roi`,
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { roi: number | null; costCents: number | null } }>();
    expect(body.data.roi).toBeNull();
    expect(body.data.costCents).toBeNull();
  });

  it("GET /v1/campaigns/:id/roi returns negative ROI when cost exceeds raised", async () => {
    const token = signToken(app);

    // Create campaign with high cost, no donations
    const createRes = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: authHeader(token),
      payload: { name: "Negative ROI Campaign", type: "digital", costCents: 100000 },
    });
    const highCostId = createRes.json<{ data: { id: string } }>().data.id;

    const res = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${highCostId}/roi`,
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { roi: number; costCents: number; totalRaisedCents: number } }>();
    expect(body.data.costCents).toBe(100000);
    expect(body.data.totalRaisedCents).toBe(0);
    // ROI = (0 - 100000) / 100000 = -1.0
    expect(body.data.roi).toBe(-1.0);
  });
});

// ─── Campaigns RLS Tenant Isolation (QA #4) ─────────────────────────────────

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
    const tokenB = signTokenB(app);
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

  it("Tenant B cannot GET Tenant A campaign by ID", async () => {
    const tokenB = signTokenB(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${campaignInA}`,
      headers: authHeader(tokenB),
    });

    expect(res.statusCode).toBe(404);
  });

  it("Tenant B cannot PATCH Tenant A campaign", async () => {
    const tokenB = signTokenB(app);
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/campaigns/${campaignInA}`,
      headers: authHeader(tokenB),
      payload: { name: "Hacked" },
    });

    expect(res.statusCode).toBe(404);
  });

  it("Tenant B cannot close Tenant A campaign", async () => {
    const tokenB = signTokenB(app);
    const res = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignInA}/close`,
      headers: authHeader(tokenB),
    });

    expect(res.statusCode).toBe(404);
  });

  it("Tenant B cannot trigger documents for Tenant A campaign", async () => {
    const tokenB = signTokenB(app);
    const res = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignInA}/documents`,
      headers: authHeader(tokenB),
      payload: { constituentIds: [] },
    });

    expect(res.statusCode).toBe(404);
  });

  it("Tenant B cannot access Tenant A campaign stats", async () => {
    const tokenB = signTokenB(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${campaignInA}/stats`,
      headers: authHeader(tokenB),
    });

    expect(res.statusCode).toBe(404);
  });

  it("Tenant B cannot access Tenant A campaign ROI", async () => {
    const tokenB = signTokenB(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${campaignInA}/roi`,
      headers: authHeader(tokenB),
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

  it("PATCH /v1/campaigns/:id without token returns 401", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/campaigns/00000000-0000-0000-0000-000000000001",
      payload: { name: "Test" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("POST /v1/campaigns/:id/close without token returns 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/campaigns/00000000-0000-0000-0000-000000000001/close",
    });
    expect(res.statusCode).toBe(401);
  });
});

// ─── Campaigns RBAC (wrong role) ─────────────────────────────────────────────

describe("Campaigns RBAC — non-admin forbidden", () => {
  it("PATCH /v1/campaigns/:id with viewer role returns 403", async () => {
    const token = signToken(app, { role: "viewer" });
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/campaigns/00000000-0000-0000-0000-000000000001",
      headers: authHeader(token),
      payload: { name: "Test" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("POST /v1/campaigns/:id/close with viewer role returns 403", async () => {
    const token = signToken(app, { role: "viewer" });
    const res = await app.inject({
      method: "POST",
      url: "/v1/campaigns/00000000-0000-0000-0000-000000000001/close",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(403);
  });

  it("POST /v1/campaigns/:id/documents with user role returns 403", async () => {
    const token = signToken(app, { role: "user" });
    const res = await app.inject({
      method: "POST",
      url: "/v1/campaigns/00000000-0000-0000-0000-000000000001/documents",
      headers: authHeader(token),
      payload: { constituentIds: [] },
    });
    expect(res.statusCode).toBe(403);
  });
});
