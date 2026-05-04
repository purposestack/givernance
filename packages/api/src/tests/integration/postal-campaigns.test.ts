/**
 * Epic #274 — postal campaigns: campaign-constituents membership, postal
 * exports, sync preview, QR-tracking metrics, bulk-email dispatch.
 *
 * These tests focus on the API surface (request/response, RBAC, validation,
 * cross-tenant isolation). The async ZIP generation itself is covered by
 * worker-side unit tests; here we just verify that POSTing the export
 * inserts a `pending` row and emits the outbox event.
 */

import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";
import { createServer } from "../../server.js";
import { authHeader, ensureTestTenants, ORG_A, signToken } from "../helpers/auth.js";

let app: FastifyInstance;
let campaignId: string;
let constituentAId: string;
let constituentBId: string;
let constituentNoEmailId: string;

/**
 * Create a campaign in the postal-export-ready state: status=active AND
 * a published public donation page. Mirrors the readiness gates that
 * `startPostalExport` enforces (Epic #274). Tests that explicitly
 * exercise the "not ready yet" branches should pass `{ activate: false }`
 * or `{ publishPage: false }` to opt out.
 */
async function createCampaign(
  name: string,
  type: "nominative_postal" | "door_drop",
  options: { activate?: boolean; publishPage?: boolean } = {},
) {
  const { activate = true, publishPage = true } = options;
  const token = signToken(app);
  const res = await app.inject({
    method: "POST",
    url: "/v1/campaigns",
    headers: authHeader(token),
    payload: { name, type },
  });
  expect(res.statusCode).toBe(201);
  const id = res.json<{ data: { id: string } }>().data.id;

  if (activate) {
    const activated = await app.inject({
      method: "PATCH",
      url: `/v1/campaigns/${id}`,
      headers: authHeader(token),
      payload: { status: "active" },
    });
    expect(activated.statusCode).toBe(200);
  }

  if (publishPage) {
    const upserted = await app.inject({
      method: "PUT",
      url: `/v1/campaigns/${id}/public-page`,
      headers: authHeader(token),
      payload: { title: name, status: "published" },
    });
    // Some test paths may not have public-page editor wired up yet —
    // accept either 200 (upsert success) or 201 (first-time create).
    expect([200, 201]).toContain(upserted.statusCode);
  }

  return id;
}

async function createConstituent(firstName: string, lastName: string, email: string | null) {
  const token = signToken(app);
  const res = await app.inject({
    method: "POST",
    url: "/v1/constituents?force=true",
    headers: authHeader(token),
    payload: {
      firstName,
      lastName,
      ...(email ? { email } : {}),
      type: "donor",
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ data: { id: string } }>().data.id;
}

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();

  campaignId = await createCampaign("Postal Test Campaign", "nominative_postal");
  constituentAId = await createConstituent("Alice", "Postal", "alice.postal@example.org");
  constituentBId = await createConstituent("Bob", "Postal", "bob.postal@example.org");
  constituentNoEmailId = await createConstituent("Carol", "NoEmail", null);
});

afterAll(async () => {
  await app.close();
});

describe("Campaign ↔ constituent membership", () => {
  it("POST /v1/campaigns/:id/constituents links constituents and is idempotent", async () => {
    const token = signToken(app);

    const first = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/constituents`,
      headers: authHeader(token),
      payload: { constituentIds: [constituentAId, constituentBId] },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json<{ data: { added: number; skipped: number } }>().data).toEqual({
      added: 2,
      skipped: 0,
    });

    // Re-adding the same ids is a no-op (idempotent on (org, campaign, constituent))
    const second = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/constituents`,
      headers: authHeader(token),
      payload: { constituentIds: [constituentAId] },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json<{ data: { added: number; skipped: number } }>().data).toEqual({
      added: 0,
      skipped: 1,
    });
  });

  it("GET /v1/campaigns/:id/constituents lists linked constituents with donation totals", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${campaignId}/constituents`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: Array<{ constituentId: string; campaignDonationCents: number }>;
      pagination: { total: number };
    }>();
    expect(body.pagination.total).toBeGreaterThanOrEqual(2);
    const ids = body.data.map((row) => row.constituentId);
    expect(ids).toContain(constituentAId);
    expect(ids).toContain(constituentBId);
    expect(body.data.every((row) => typeof row.campaignDonationCents === "number")).toBe(true);
  });

  it("DELETE removes a single membership link", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/campaigns/${campaignId}/constituents/${constituentBId}`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { removed: boolean } }>().data.removed).toBe(true);

    // Removing again is a soft-no-op (false) — endpoint stays idempotent.
    const second = await app.inject({
      method: "DELETE",
      url: `/v1/campaigns/${campaignId}/constituents/${constituentBId}`,
      headers: authHeader(token),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json<{ data: { removed: boolean } }>().data.removed).toBe(false);
  });

  it("rejects linking constituents to a door_drop campaign with 400", async () => {
    const token = signToken(app);
    const doorDropId = await createCampaign("Door Drop Test", "door_drop");

    const res = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${doorDropId}/constituents`,
      headers: authHeader(token),
      payload: { constituentIds: [constituentAId] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 when the campaign does not belong to the tenant", async () => {
    const token = signToken(app);
    const otherCampaignId = "00000000-0000-0000-0000-000000000999";
    const res = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${otherCampaignId}/constituents`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("Postal exports", () => {
  it("POST /v1/campaigns/:id/postal-exports queues a personalized job", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/postal-exports`,
      headers: authHeader(token),
      payload: { mode: "personalized" },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json<{
      data: {
        id: string;
        mode: string;
        status: string;
        totalCount: number;
        progressCount: number;
      };
    }>();
    expect(body.data.mode).toBe("personalized");
    expect(body.data.status).toBe("pending");
    expect(body.data.progressCount).toBe(0);
    // After the bob delete above, only Alice remains linked to campaignId.
    expect(body.data.totalCount).toBeGreaterThanOrEqual(1);

    const outboxRows = await db.execute(sql`
      SELECT type FROM outbox_events
      WHERE tenant_id = ${ORG_A}::uuid
        AND type = 'campaign.postal_export_requested'
        AND payload->>'exportId' = ${body.data.id}
    `);
    expect(outboxRows.rows.length).toBe(1);
  });

  it("POST personalized export with no recipients returns 400", async () => {
    const token = signToken(app);
    const emptyCampaignId = await createCampaign("Empty postal", "nominative_postal");
    const res = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${emptyCampaignId}/postal-exports`,
      headers: authHeader(token),
      payload: { mode: "personalized" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ title: string }>().title).toBe("no_recipients");
  });

  it("POST export on a draft campaign returns 400 campaign_not_active", async () => {
    const token = signToken(app);
    const draftCampaignId = await createCampaign("Still draft", "door_drop", {
      activate: false,
      // publishPage doesn't matter here — the active-campaign gate fires first.
    });
    const res = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${draftCampaignId}/postal-exports`,
      headers: authHeader(token),
      payload: { mode: "door_drop" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ title: string }>().title).toBe("campaign_not_active");
  });

  it("POST export with no public page returns 400 public_page_missing", async () => {
    const token = signToken(app);
    const noPageId = await createCampaign("Active w/o public page", "door_drop", {
      publishPage: false,
    });
    const res = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${noPageId}/postal-exports`,
      headers: authHeader(token),
      payload: { mode: "door_drop" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ title: string }>().title).toBe("public_page_missing");
  });

  it("POST export with a draft public page returns 400 public_page_draft", async () => {
    const token = signToken(app);
    const draftPageId = await createCampaign("Active, draft page", "door_drop", {
      publishPage: false,
    });
    // Upsert as draft (the canonical createCampaign helper publishes; we
    // call the raw endpoint here to leave the page in `draft` state).
    const upserted = await app.inject({
      method: "PUT",
      url: `/v1/campaigns/${draftPageId}/public-page`,
      headers: authHeader(token),
      payload: { title: "Draft page", status: "draft" },
    });
    expect([200, 201]).toContain(upserted.statusCode);

    const res = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${draftPageId}/postal-exports`,
      headers: authHeader(token),
      payload: { mode: "door_drop" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ title: string }>().title).toBe("public_page_draft");
  });

  it("POST door_drop export queues a single-document job for any campaign type", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/postal-exports`,
      headers: authHeader(token),
      payload: { mode: "door_drop" },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json<{ data: { totalCount: number; mode: string } }>();
    expect(body.data.mode).toBe("door_drop");
    expect(body.data.totalCount).toBe(1);
  });

  it("GET /v1/campaigns/:id/postal-exports lists recent jobs newest-first", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${campaignId}/postal-exports`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: Array<{ id: string; createdAt: string }>;
    }>();
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    // newest-first: createdAt should be monotonically non-increasing
    for (let i = 1; i < body.data.length; i += 1) {
      const prev = new Date(body.data[i - 1]?.createdAt ?? 0).getTime();
      const cur = new Date(body.data[i]?.createdAt ?? 0).getTime();
      expect(prev).toBeGreaterThanOrEqual(cur);
    }
  });

  it("GET single postal export returns 404 when the id is unknown", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${campaignId}/postal-exports/00000000-0000-0000-0000-00000000abcd`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET download returns 409 while the export is still pending", async () => {
    const token = signToken(app);
    const startRes = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/postal-exports`,
      headers: authHeader(token),
      payload: { mode: "door_drop" },
    });
    const exportId = startRes.json<{ data: { id: string } }>().data.id;

    const downloadRes = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${campaignId}/postal-exports/${exportId}/download`,
      headers: authHeader(token),
    });
    expect(downloadRes.statusCode).toBe(409);
  });
});

describe("Postal preview", () => {
  it("POST /v1/campaigns/:id/postal-preview returns a PDF buffer", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/postal-preview`,
      headers: authHeader(token),
      payload: { mode: "personalized" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    // PDF magic header `%PDF-` (25 50 44 46 2D)
    expect(res.rawPayload.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("preview returns 404 for an unknown campaign", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/campaigns/00000000-0000-0000-0000-00000000beef/postal-preview",
      headers: authHeader(token),
      payload: { mode: "personalized" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("QR tracking metrics", () => {
  it("GET /v1/campaigns/:id/qr-stats returns zeroed metrics for a campaign with no codes", async () => {
    const token = signToken(app);
    const freshCampaignId = await createCampaign("QR Stats Campaign", "nominative_postal");

    const res = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${freshCampaignId}/qr-stats`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: Record<string, number> }>().data).toEqual({
      campaignId: freshCampaignId,
      totalCodes: 0,
      scannedCodes: 0,
      qrAttributedDonations: 0,
      qrAttributedAmountCents: 0,
    });
  });

  it("counts QR codes seeded directly into the campaign", async () => {
    const token = signToken(app);
    const freshCampaignId = await createCampaign("QR Stats Seeded", "nominative_postal");

    // Seed-row codes must be unique per test invocation — the campaign_qr_codes
    // table has a UNIQUE(org_id, code) constraint, and the test suite is
    // re-runnable without a tear-down between invocations.
    const seedSuffix = Date.now().toString(36);
    await db.execute(sql`
      INSERT INTO campaign_qr_codes (org_id, campaign_id, constituent_id, code, scanned_at)
      VALUES
        (${ORG_A}::uuid, ${freshCampaignId}::uuid, NULL, ${`qrtoken_seed_a_${seedSuffix}`}, NULL),
        (${ORG_A}::uuid, ${freshCampaignId}::uuid, NULL, ${`qrtoken_seed_b_${seedSuffix}`}, now())
    `);

    const res = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${freshCampaignId}/qr-stats`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const data = res.json<{
      data: { totalCodes: number; scannedCodes: number };
    }>().data;
    expect(data.totalCodes).toBe(2);
    expect(data.scannedCodes).toBe(1);
  });
});

describe("Bulk email dispatch", () => {
  it("POST /v1/constituents/bulk-email queues an outbox event and reports skipped recipients", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents/bulk-email",
      headers: authHeader(token),
      payload: {
        constituentIds: [constituentAId, constituentNoEmailId],
        subject: "Test bulk email",
        body: "Hello supporters, please scan the QR code in your letter.",
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json<{ data: { queued: number; skippedNoEmail: number } }>().data).toEqual({
      queued: 1,
      skippedNoEmail: 1,
    });

    const outboxRows = await db.execute(sql`
      SELECT type, payload FROM outbox_events
      WHERE tenant_id = ${ORG_A}::uuid
        AND type = 'communication.bulk_email_requested'
      ORDER BY created_at DESC
      LIMIT 1
    `);
    expect(outboxRows.rows.length).toBe(1);
    const payload = (outboxRows.rows[0] as { payload: { recipients?: unknown[] } }).payload;
    expect(payload.recipients).toBeDefined();
    expect(Array.isArray(payload.recipients)).toBe(true);
  });

  it("rejects empty bulk-email selection with 400", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents/bulk-email",
      headers: authHeader(token),
      payload: {
        constituentIds: [],
        subject: "Empty",
        body: "Empty",
      },
    });
    // TypeBox rejects with 400 before the service runs.
    expect(res.statusCode).toBe(400);
  });

  it("rejects bulk-email with constituents from another tenant with 400", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents/bulk-email",
      headers: authHeader(token),
      payload: {
        constituentIds: ["00000000-0000-0000-0000-00000000bad1"],
        subject: "Cross-tenant",
        body: "Should fail",
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("Constituent list filters (Epic #274)", () => {
  it("GET /v1/constituents?campaignId restricts to linked constituents", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/constituents?campaignId=${campaignId}`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ id: string }> }>();
    const ids = body.data.map((row) => row.id);
    expect(ids).toContain(constituentAId);
    // Bob was unlinked above
    expect(ids).not.toContain(constituentBId);
    // Carol was never linked
    expect(ids).not.toContain(constituentNoEmailId);
  });

  it("GET /v1/constituents?minLifetimeAmountCents=1 filters out constituents with no donations", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents?minLifetimeAmountCents=1",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    // None of our test constituents have donations recorded — so the result
    // should be empty (the aggregate join coalesces NULL → 0 and filters out).
    const ids = res.json<{ data: Array<{ id: string }> }>().data.map((r) => r.id);
    expect(ids).not.toContain(constituentAId);
    expect(ids).not.toContain(constituentBId);
  });
});
