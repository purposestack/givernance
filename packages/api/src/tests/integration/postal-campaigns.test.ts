/**
 * Epic #274 — postal campaigns: campaign-constituents membership, postal
 * exports, sync preview, QR-tracking metrics, bulk-email dispatch.
 *
 * These tests focus on the API surface (request/response, RBAC, validation,
 * cross-tenant isolation). The async ZIP generation itself is covered by
 * worker-side unit tests; here we just verify that POSTing the export
 * inserts a `pending` row and emits the outbox event.
 */

import { Readable } from "node:stream";
import { campaignPostalExports, featureFlags } from "@givernance/shared/schema";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { flagService } from "../../lib/flags/flag-service.js";
import { redis } from "../../lib/redis.js";
import { createServer } from "../../server.js";
import {
  authHeader,
  ensureTestTenants,
  ORG_A,
  ORG_B,
  seedTenantUser,
  signToken,
} from "../helpers/auth.js";
import { db } from "../helpers/db.js";

// Partial-mock the S3 helper so the download route can stream a fake object
// without MinIO (project item #194221573 — exercise the format-aware
// content-type branch). `vi.mock` is hoisted above the imports by vitest, so
// placement here is cosmetic. Only `fetchCampaignObject` is overridden;
// every other s3 export stays real, and no other route exercised in this
// file reads from `fetchCampaignObject`.
vi.mock("../../lib/s3.js", async (importActual) => {
  const actual = await importActual<typeof import("../../lib/s3.js")>();
  return {
    ...actual,
    fetchCampaignObject: vi.fn(async () => ({
      body: Readable.from(Buffer.from("%PDF-1.4 fake")),
      contentLength: 12,
    })),
  };
});

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

  it("DELETE /constituents clears the whole list and returns the count removed", async () => {
    const token = signToken(app);
    // Dedicated campaign so wiping its list doesn't disturb other tests.
    const clearCampaignId = await createCampaign("Clear-list campaign", "nominative_postal");
    await app.inject({
      method: "POST",
      url: `/v1/campaigns/${clearCampaignId}/constituents`,
      headers: authHeader(token),
      payload: { constituentIds: [constituentAId, constituentBId] },
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/campaigns/${clearCampaignId}/constituents`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { removed: number } }>().data.removed).toBe(2);

    // The list is now empty.
    const after = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${clearCampaignId}/constituents`,
      headers: authHeader(token),
    });
    expect(after.json<{ pagination: { total: number } }>().pagination.total).toBe(0);

    // Idempotent — clearing an already-empty list returns 0.
    const again = await app.inject({
      method: "DELETE",
      url: `/v1/campaigns/${clearCampaignId}/constituents`,
      headers: authHeader(token),
    });
    expect(again.statusCode).toBe(200);
    expect(again.json<{ data: { removed: number } }>().data.removed).toBe(0);
  });

  it("GET /constituents sorts by name across the whole list (server-side)", async () => {
    const token = signToken(app);
    const sortCampaignId = await createCampaign("Sort campaign", "nominative_postal");
    await app.inject({
      method: "POST",
      url: `/v1/campaigns/${sortCampaignId}/constituents`,
      headers: authHeader(token),
      payload: { constituentIds: [constituentAId, constituentBId, constituentNoEmailId] },
    });

    const asc = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${sortCampaignId}/constituents?sort=name&order=asc`,
      headers: authHeader(token),
    });
    expect(asc.statusCode).toBe(200);
    const ascFirst = asc
      .json<{ data: Array<{ firstName: string }> }>()
      .data.map((m) => m.firstName);
    // Alice < Bob < Carol on (firstName, lastName).
    expect(ascFirst[0]).toBe("Alice");

    const desc = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${sortCampaignId}/constituents?sort=name&order=desc`,
      headers: authHeader(token),
    });
    const descFirst = desc
      .json<{ data: Array<{ firstName: string }> }>()
      .data.map((m) => m.firstName);
    expect(descFirst[0]).toBe("Carol");
  });

  it("GET /constituents name sort collates accents next to their base letter (ICU)", async () => {
    const token = signToken(app);
    const accentCampaignId = await createCampaign("Accent sort campaign", "nominative_postal");
    const elise = await createConstituent("Élise", "Zola", null);
    const victor = await createConstituent("Victor", "Adam", null);
    await app.inject({
      method: "POST",
      url: `/v1/campaigns/${accentCampaignId}/constituents`,
      headers: authHeader(token),
      payload: { constituentIds: [elise, victor] },
    });

    const res = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${accentCampaignId}/constituents?sort=name&order=asc`,
      headers: authHeader(token),
    });
    const names = res.json<{ data: Array<{ firstName: string }> }>().data.map((m) => m.firstName);
    // "Élise" must sort BEFORE "Victor" (É collates near E) — not after the
    // whole ASCII alphabet as the DB's default collation would put it.
    expect(names).toEqual(["Élise", "Victor"]);
  });

  it("GET /v1/constituents?excludeCampaignId omits constituents already on that campaign", async () => {
    const token = signToken(app);
    const excludeCampaignId = await createCampaign("Exclude-picker campaign", "nominative_postal");
    // Link Alice to this campaign; Bob stays unlinked.
    await app.inject({
      method: "POST",
      url: `/v1/campaigns/${excludeCampaignId}/constituents`,
      headers: authHeader(token),
      payload: { constituentIds: [constituentAId] },
    });

    const res = await app.inject({
      method: "GET",
      url: `/v1/constituents?excludeCampaignId=${excludeCampaignId}&perPage=100`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const ids = res.json<{ data: Array<{ id: string }> }>().data.map((c) => c.id);
    // Alice is on the campaign → excluded; Bob is not → still offered.
    expect(ids).not.toContain(constituentAId);
    expect(ids).toContain(constituentBId);
  });

  it("DELETE /constituents returns 404 for a campaign in another tenant", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/campaigns/00000000-0000-0000-0000-000000000999/constituents`,
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

  it("POST export with no public page AND no bank account returns 400 postal_export_not_configured", async () => {
    // Epic #318 PR #4 — when both rails are off, the export resolver
    // returns the blocked-mode error code instead of the misleading
    // `public_page_missing` (which implied the operator must publish a
    // page when their actual intent might be Swiss QR-bill only).
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
    expect(res.json<{ title: string }>().title).toBe("postal_export_not_configured");
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

describe("Postal exports — merged PDF format (project item #194221573, flag off)", () => {
  // Seeded `enabled = false` by migration 0081. Default state — assert
  // defensively (other suites toggle flags) and exercise the off-path.
  beforeAll(async () => {
    await db
      .update(featureFlags)
      .set({ enabled: false })
      .where(eq(featureFlags.key, "campaign.postal_merged_pdf"));
    await flagService.invalidate();
  });

  it("rejects format=merged_pdf with 400 merged_pdf_disabled when the flag is off", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/postal-exports`,
      headers: authHeader(token),
      payload: { mode: "door_drop", format: "merged_pdf" },
    });
    expect(res.statusCode).toBe(400);
    // RFC 9457 problem-detail body: structured `title` = the error code.
    const body = res.json<{ type: string; title: string; status: number; detail: string }>();
    expect(body.title).toBe("merged_pdf_disabled");
    expect(body.status).toBe(400);
    expect(typeof body.detail).toBe("string");
  });

  it("still accepts a ZIP export while the merged-PDF flag is off", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/postal-exports`,
      headers: authHeader(token),
      payload: { mode: "door_drop", format: "zip" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json<{ data: { format: string } }>().data.format).toBe("zip");
  });

  it("defaults to ZIP when no format is supplied (back-compat)", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/postal-exports`,
      headers: authHeader(token),
      payload: { mode: "door_drop" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json<{ data: { format: string } }>().data.format).toBe("zip");
  });
});

describe("Postal exports — merged PDF format (project item #194221573, flag on)", () => {
  beforeAll(async () => {
    await db
      .update(featureFlags)
      .set({ enabled: true })
      .where(eq(featureFlags.key, "campaign.postal_merged_pdf"));
    await flagService.invalidate();
  });
  afterAll(async () => {
    await db
      .update(featureFlags)
      .set({ enabled: false })
      .where(eq(featureFlags.key, "campaign.postal_merged_pdf"));
    await flagService.invalidate();
  });

  it("accepts format=merged_pdf and persists it on the row + outbox payload", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/postal-exports`,
      headers: authHeader(token),
      payload: { mode: "door_drop", format: "merged_pdf" },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json<{ data: { id: string; format: string } }>();
    expect(body.data.format).toBe("merged_pdf");

    const outbox = await db.execute(sql`
      SELECT payload->>'format' AS format
      FROM outbox_events
      WHERE tenant_id = ${ORG_A}::uuid
        AND type = 'campaign.postal_export_requested'
        AND payload->>'exportId' = ${body.data.id}
    `);
    expect(outbox.rows[0]?.format).toBe("merged_pdf");
  });

  it("works for personalized mode too (format is mode-agnostic)", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/postal-exports`,
      headers: authHeader(token),
      payload: { mode: "personalized", format: "merged_pdf" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json<{ data: { format: string } }>().data.format).toBe("merged_pdf");
  });

  it("rejects merged_pdf above MERGED_PDF_MAX_RECIPIENTS with 400 merged_pdf_too_many_recipients", async () => {
    const token = signToken(app);
    const capCampaignId = await createCampaign("Mass merged campaign", "nominative_postal");
    // Bulk-seed 2001 linked constituents in one statement (> the 2000 cap).
    // Uses the owner-role test pool, so RLS is bypassed for the fixture
    // setup — the route under test still runs under its own RLS context.
    await db.execute(sql`
      WITH ins AS (
        INSERT INTO constituents (org_id, first_name, last_name, type)
        SELECT ${ORG_A}::uuid, 'Mass', 'Recipient' || g, 'donor'
        FROM generate_series(1, 2001) AS g
        RETURNING id
      )
      INSERT INTO campaign_constituents (org_id, campaign_id, constituent_id)
      SELECT ${ORG_A}::uuid, ${capCampaignId}::uuid, id FROM ins
    `);

    const res = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${capCampaignId}/postal-exports`,
      headers: authHeader(token),
      payload: { mode: "personalized", format: "merged_pdf" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ title: string }>().title).toBe("merged_pdf_too_many_recipients");

    // ZIP has no cap — the same oversized campaign exports fine as a ZIP.
    const zipRes = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${capCampaignId}/postal-exports`,
      headers: authHeader(token),
      payload: { mode: "personalized", format: "zip" },
    });
    expect(zipRes.statusCode).toBe(202);
  });

  it("rejects an unknown format value at schema validation (400)", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/postal-exports`,
      headers: authHeader(token),
      payload: { mode: "door_drop", format: "tarball" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("download serves application/pdf with a .pdf filename for a completed merged_pdf export", async () => {
    const token = signToken(app);
    // Seed a completed merged_pdf export row directly (the worker normally
    // produces this); the S3 fetch is mocked at the top of the file.
    const [row] = await db
      .insert(campaignPostalExports)
      .values({
        orgId: ORG_A,
        campaignId,
        mode: "door_drop",
        format: "merged_pdf",
        status: "completed",
        totalCount: 1,
        progressCount: 1,
        zipS3Path: `${ORG_A}/campaigns/${campaignId}/exports/merged.pdf`,
        completedAt: new Date(),
      })
      .returning();

    const res = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${campaignId}/postal-exports/${row!.id}/download`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.headers["content-disposition"]).toContain(".pdf");
    expect(res.headers["content-disposition"]).not.toContain(".zip");
  });

  it("download serves application/zip with a .zip filename for a completed zip export", async () => {
    const token = signToken(app);
    const [row] = await db
      .insert(campaignPostalExports)
      .values({
        orgId: ORG_A,
        campaignId,
        mode: "door_drop",
        format: "zip",
        status: "completed",
        totalCount: 1,
        progressCount: 1,
        zipS3Path: `${ORG_A}/campaigns/${campaignId}/exports/bundle.zip`,
        completedAt: new Date(),
      })
      .returning();

    const res = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${campaignId}/postal-exports/${row!.id}/download`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/zip");
    expect(res.headers["content-disposition"]).toContain(".zip");
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

  // Issue #495 — the QR-bill preview hardcoded a QRR fixture reference for
  // every Swiss-linked campaign. `swissqrbill` v4 throws "QR-Reference
  // requires the use of a QR-IBAN" when a QRR reference is paired with a
  // *regular* IBAN, so the preview 500'd for every campaign whose linked
  // account is a regular IBAN (the common case) even though the real
  // export rendered fine (the worker resolves QRR-vs-SCOR from the IBAN
  // kind). These two tests lock both branches: regular IBAN → SCOR
  // fixture → renders; QR-IBAN → QRR fixture → renders.
  const REGULAR_CH_IBAN = "CH9300762011623852957";
  const QR_CH_IBAN = "CH4431999123000889012";
  const QR_BILL_HOLDER = {
    holderName: "Association Givernance Test (#495)",
    holderStreet: "Rue de la Paix",
    holderBuildingNumber: "12",
    holderPostalCode: "1003",
    holderTown: "Lausanne",
    holderCountryCode: "CH",
  };

  async function createBankLinkedCampaign(iban: string): Promise<string> {
    const token = signToken(app);
    // Fresh slate — the partial unique (org_id, iban) WHERE deleted_at IS
    // NULL would otherwise collide across re-runs on the persistent DB.
    await db.execute(sql`DELETE FROM bank_accounts WHERE org_id = ${ORG_A} AND iban = ${iban}`);
    const bank = await app.inject({
      method: "POST",
      url: "/v1/bank-accounts",
      headers: authHeader(token),
      payload: { ...QR_BILL_HOLDER, iban, bankName: "PostFinance", currency: "CHF" },
    });
    expect(bank.statusCode).toBe(201);
    const bankAccountId = bank.json<{ data: { id: string } }>().data.id;

    // No public page → qr_bill_only mode → single inline PDF (not a ZIP),
    // so the assertion stays a clean `%PDF-` magic-header check.
    const campaign = await createCampaign("QR-bill preview campaign", "nominative_postal", {
      publishPage: false,
    });
    const linked = await app.inject({
      method: "PATCH",
      url: `/v1/campaigns/${campaign}`,
      headers: authHeader(token),
      payload: { bankAccountId },
    });
    expect(linked.statusCode).toBe(200);
    return campaign;
  }

  it("preview renders a QR-bill PDF for a campaign linked to a REGULAR IBAN (SCOR, issue #495)", async () => {
    const token = signToken(app);
    const id = await createBankLinkedCampaign(REGULAR_CH_IBAN);
    const res = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${id}/postal-preview`,
      headers: authHeader(token),
      payload: { mode: "personalized" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.rawPayload.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("preview renders a QR-bill PDF for a campaign linked to a QR-IBAN (QRR)", async () => {
    const token = signToken(app);
    const id = await createBankLinkedCampaign(QR_CH_IBAN);
    const res = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${id}/postal-preview`,
      headers: authHeader(token),
      payload: { mode: "personalized" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.rawPayload.subarray(0, 5).toString("ascii")).toBe("%PDF-");
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
  // The bulk-email feature is shipped behind the
  // `communication.bulk_email` feature flag (PR #352 / @magino review).
  // Seeded `enabled = false` by migration 0047. Force it ON for the
  // duration of these tests so we exercise the original behaviour;
  // the dedicated `feature-flags.test.ts` covers the off-path.
  beforeAll(async () => {
    await db
      .update(featureFlags)
      .set({ enabled: true })
      .where(eq(featureFlags.key, "communication.bulk_email"));
    await flagService.invalidate();
  });
  afterAll(async () => {
    await db
      .update(featureFlags)
      .set({ enabled: false })
      .where(eq(featureFlags.key, "communication.bulk_email"));
    await flagService.invalidate();
  });

  // The bulk-email POST + resume POST routes are rate-limited at 10/min
  // each. This file now contains a dozen+ tests that hit them in a
  // single test-file run; clear the rate-limit keys between tests so a
  // suite that wouldn't trip the limit in real usage doesn't bleed
  // 429s across unrelated assertions. Same pattern as
  // `signup.test.ts` and `team-invitations.test.ts`.
  beforeEach(async () => {
    const keys = await redis.keys("*rate-limit*");
    if (keys.length > 0) await redis.del(...keys);
  });

  it("POST /v1/constituents/bulk-email creates a tracking row + outbox event with only the job id (issue #326)", async () => {
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
    const body = res.json<{
      data: { jobId: string; queued: number; skippedNoEmail: number };
    }>().data;
    expect(body.queued).toBe(1);
    expect(body.skippedNoEmail).toBe(1);
    expect(body.jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.location).toBe(`/v1/constituents/bulk-email-jobs/${body.jobId}`);

    // Tracking row holds the deliverable id snapshot + zero counters.
    // PII (email, name) stays out of bulk_email_jobs — only uuids.
    const trackingRows = await db.execute(sql`
      SELECT
        status,
        total_recipients,
        delivered_count,
        failed_count,
        constituent_ids,
        delivered_constituent_ids,
        failed_constituent_ids,
        parent_job_id,
        subject
      FROM bulk_email_jobs
      WHERE id = ${body.jobId}::uuid
    `);
    expect(trackingRows.rows.length).toBe(1);
    const tracking = trackingRows.rows[0] as {
      status: string;
      total_recipients: number;
      delivered_count: number;
      failed_count: number;
      constituent_ids: string[];
      delivered_constituent_ids: string[];
      failed_constituent_ids: string[];
      parent_job_id: string | null;
      subject: string;
    };
    expect(tracking.status).toBe("pending");
    expect(tracking.total_recipients).toBe(1);
    expect(tracking.delivered_count).toBe(0);
    expect(tracking.failed_count).toBe(0);
    expect(tracking.constituent_ids).toEqual([constituentAId]);
    expect(tracking.delivered_constituent_ids).toEqual([]);
    expect(tracking.failed_constituent_ids).toEqual([]);
    expect(tracking.parent_job_id).toBeNull();
    expect(tracking.subject).toBe("Test bulk email");

    // Outbox payload now carries only the tracking row id — the worker
    // re-reads subject/body/recipient_ids from the DB. No PII, no
    // recipient list snapshot in the BullMQ payload.
    const outboxRows = await db.execute(sql`
      SELECT payload FROM outbox_events
      WHERE tenant_id = ${ORG_A}::uuid
        AND type = 'communication.bulk_email_requested'
      ORDER BY created_at DESC
      LIMIT 1
    `);
    expect(outboxRows.rows.length).toBe(1);
    const payload = (
      outboxRows.rows[0] as {
        payload: {
          bulkEmailJobId?: string;
          constituentIds?: unknown[];
          recipients?: unknown;
          subject?: unknown;
          body?: unknown;
        };
      }
    ).payload;
    expect(payload.bulkEmailJobId).toBe(body.jobId);
    expect(payload.constituentIds).toBeUndefined();
    expect(payload.recipients).toBeUndefined();
    expect(payload.subject).toBeUndefined();
    expect(payload.body).toBeUndefined();
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

describe("Bulk email job tracking + resume (issue #326)", () => {
  beforeAll(async () => {
    await db
      .update(featureFlags)
      .set({ enabled: true })
      .where(eq(featureFlags.key, "communication.bulk_email"));
    await flagService.invalidate();
  });
  afterAll(async () => {
    await db
      .update(featureFlags)
      .set({ enabled: false })
      .where(eq(featureFlags.key, "communication.bulk_email"));
    await flagService.invalidate();
  });

  beforeEach(async () => {
    const keys = await redis.keys("*rate-limit*");
    if (keys.length > 0) await redis.del(...keys);
  });

  it("GET /v1/constituents/bulk-email-jobs lists the newest jobs first", async () => {
    const token = signToken(app);

    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents/bulk-email-jobs",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: Array<{
        id: string;
        status: string;
        subject: string;
        totalRecipients: number;
        deliveredCount: number;
        stalled: boolean;
        createdAt: string;
      }>;
    }>();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    // Every `pending` row in the list must report `stalled === false`
    // (the flag only flips for `processing` rows whose updated_at has
    // gone stale). The list mixes pending + processing in this suite —
    // we check the property surface, not the value of every row.
    for (const row of body.data) {
      if (row.status === "pending") {
        expect(row.stalled).toBe(false);
      }
      // Boolean shape regardless of status.
      expect(typeof row.stalled).toBe("boolean");
    }
    // Newest-first ordering.
    const timestamps = body.data.map((row) => new Date(row.createdAt).getTime());
    const sorted = [...timestamps].sort((a, b) => b - a);
    expect(timestamps).toEqual(sorted);
  });

  it("GET /v1/constituents/bulk-email-jobs/:id polls a single job", async () => {
    // Create a fresh job to query.
    const token = signToken(app);
    const dispatch = await app.inject({
      method: "POST",
      url: "/v1/constituents/bulk-email",
      headers: authHeader(token),
      payload: {
        constituentIds: [constituentAId],
        subject: "Poll me",
        body: "Polling test.",
      },
    });
    expect(dispatch.statusCode).toBe(202);
    const { jobId } = dispatch.json<{ data: { jobId: string } }>().data;

    const res = await app.inject({
      method: "GET",
      url: `/v1/constituents/bulk-email-jobs/${jobId}`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const view = res.json<{ data: { id: string; status: string; totalRecipients: number } }>().data;
    expect(view.id).toBe(jobId);
    expect(view.status).toBe("pending");
    expect(view.totalRecipients).toBe(1);
  });

  it("GET /v1/constituents/bulk-email-jobs/:id 404s for unknown ids", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents/bulk-email-jobs/00000000-0000-0000-0000-000000000bad",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(404);
  });

  it("POST /v1/constituents/bulk-email-jobs/:id/resume rejects a pending source as still-running (400)", async () => {
    const token = signToken(app);
    const dispatch = await app.inject({
      method: "POST",
      url: "/v1/constituents/bulk-email",
      headers: authHeader(token),
      payload: {
        constituentIds: [constituentAId],
        subject: "Pending source",
        body: "Still running.",
      },
    });
    expect(dispatch.statusCode).toBe(202);
    const { jobId } = dispatch.json<{ data: { jobId: string } }>().data;

    const res = await app.inject({
      method: "POST",
      url: `/v1/constituents/bulk-email-jobs/${jobId}/resume`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(400);
    const problem = res.json<{ title: string; status: number }>();
    expect(problem.title).toBe("job_still_running");
    expect(problem.status).toBe(400);
  });

  it("POST /v1/constituents/bulk-email-jobs/:id/resume creates a new job for the remaining recipients of a partial source", async () => {
    const token = signToken(app);

    // Stage a partial source row directly: 2 requested, 1 delivered, 0
    // failed. Simulates the Redis-wipe scenario described in issue #326
    // — the worker delivered to one recipient and never touched the
    // other before the BullMQ job vanished.
    const sourceJob = await db.execute<{ id: string }>(sql`
      INSERT INTO bulk_email_jobs (
        org_id, status, subject, body,
        constituent_ids,
        delivered_constituent_ids,
        failed_constituent_ids,
        total_recipients, delivered_count, failed_count
      ) VALUES (
        ${ORG_A}::uuid,
        'partial',
        'Partial source',
        'Body of the partial source job.',
        ARRAY[${constituentAId}::uuid, ${constituentBId}::uuid],
        ARRAY[${constituentAId}::uuid],
        ARRAY[]::uuid[],
        2, 1, 0
      )
      RETURNING id
    `);
    const sourceId = sourceJob.rows[0]?.id;
    expect(sourceId).toBeDefined();
    if (!sourceId) throw new Error("Failed to seed source row");

    const res = await app.inject({
      method: "POST",
      url: `/v1/constituents/bulk-email-jobs/${sourceId}/resume`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(202);
    const resumed = res.json<{
      data: {
        id: string;
        status: string;
        subject: string;
        totalRecipients: number;
        deliveredCount: number;
        parentJobId: string | null;
      };
    }>().data;
    expect(resumed.status).toBe("pending");
    expect(resumed.subject).toBe("Partial source");
    expect(resumed.totalRecipients).toBe(1);
    expect(resumed.deliveredCount).toBe(0);
    expect(resumed.parentJobId).toBe(sourceId);
    expect(res.headers.location).toBe(`/v1/constituents/bulk-email-jobs/${resumed.id}`);

    // The new row's constituent_ids must be exactly the recipient that
    // wasn't delivered in the source.
    const resumedRows = await db.execute(sql`
      SELECT constituent_ids
      FROM bulk_email_jobs
      WHERE id = ${resumed.id}::uuid
    `);
    expect((resumedRows.rows[0] as { constituent_ids: string[] }).constituent_ids).toEqual([
      constituentBId,
    ]);

    // A fresh outbox event is queued for the resume — same shape as a
    // first-time dispatch (only carries the bulkEmailJobId).
    const outboxRows = await db.execute(sql`
      SELECT payload FROM outbox_events
      WHERE tenant_id = ${ORG_A}::uuid
        AND type = 'communication.bulk_email_requested'
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const payload = (outboxRows.rows[0] as { payload: { bulkEmailJobId?: string } }).payload;
    expect(payload.bulkEmailJobId).toBe(resumed.id);
  });

  it("POST /v1/constituents/bulk-email-jobs/:id/resume 400s when nothing is left to resume", async () => {
    const token = signToken(app);

    // A `completed` source: delivered_count == total_recipients.
    const completed = await db.execute<{ id: string }>(sql`
      INSERT INTO bulk_email_jobs (
        org_id, status, subject, body,
        constituent_ids,
        delivered_constituent_ids,
        failed_constituent_ids,
        total_recipients, delivered_count, failed_count
      ) VALUES (
        ${ORG_A}::uuid,
        'completed',
        'Fully delivered',
        'Body.',
        ARRAY[${constituentAId}::uuid],
        ARRAY[${constituentAId}::uuid],
        ARRAY[]::uuid[],
        1, 1, 0
      )
      RETURNING id
    `);
    const completedId = completed.rows[0]?.id;
    if (!completedId) throw new Error("Failed to seed completed row");

    const res = await app.inject({
      method: "POST",
      url: `/v1/constituents/bulk-email-jobs/${completedId}/resume`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(400);
    const problem = res.json<{ title: string }>();
    expect(problem.title).toBe("nothing_to_resume");
  });

  it("POST /v1/constituents/bulk-email-jobs/:id/resume 404s for unknown ids (separate code path from validation 400)", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents/bulk-email-jobs/00000000-0000-0000-0000-000000000bad/resume",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(404);
    const problem = res.json<{ title: string }>();
    expect(problem.title).toBe("job_not_found");
  });

  it("POST /v1/constituents/bulk-email-jobs/:id/resume accepts a stalled processing source (Redis-wipe scenario, issue #326)", async () => {
    const token = signToken(app);

    // A `processing` row whose `updated_at` is 30 minutes in the past —
    // server treats this as stalled (the BULK_EMAIL_STALL_MS threshold
    // is 10 minutes) and lets the resume go through.
    const stalled = await db.execute<{ id: string }>(sql`
      INSERT INTO bulk_email_jobs (
        org_id, status, subject, body,
        constituent_ids,
        delivered_constituent_ids,
        failed_constituent_ids,
        total_recipients, delivered_count, failed_count,
        updated_at
      ) VALUES (
        ${ORG_A}::uuid,
        'processing',
        'Stalled source',
        'Worker died mid-fan-out.',
        ARRAY[${constituentAId}::uuid, ${constituentBId}::uuid],
        ARRAY[]::uuid[],
        ARRAY[]::uuid[],
        2, 0, 0,
        NOW() - INTERVAL '30 minutes'
      )
      RETURNING id
    `);
    const stalledId = stalled.rows[0]?.id;
    if (!stalledId) throw new Error("Failed to seed stalled row");

    const res = await app.inject({
      method: "POST",
      url: `/v1/constituents/bulk-email-jobs/${stalledId}/resume`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(202);
    const resumed = res.json<{
      data: { totalRecipients: number; parentJobId: string | null };
    }>().data;
    // 0 delivered ⇒ resume re-targets the full set.
    expect(resumed.totalRecipients).toBe(2);
    expect(resumed.parentJobId).toBe(stalledId);
  });

  it("counts/array CHECK constraint rejects drifted counter writes (defence-in-depth)", async () => {
    // Direct SQL: deliver_count says 5 but the array has 1 entry. The
    // CHECK constraint from migration 0045 must reject the INSERT.
    await expect(
      db.execute(sql`
        INSERT INTO bulk_email_jobs (
          org_id, status, subject, body,
          constituent_ids,
          delivered_constituent_ids,
          failed_constituent_ids,
          total_recipients, delivered_count, failed_count
        ) VALUES (
          ${ORG_A}::uuid,
          'partial',
          'Drifted counters',
          'Should be rejected by CHECK.',
          ARRAY[${constituentAId}::uuid],
          ARRAY[${constituentAId}::uuid],
          ARRAY[]::uuid[],
          1, 5, 0
        )
      `),
    ).rejects.toThrow();
  });

  // PR #352 review M2: lock the RFC 9457 body shape on at least one error
  // path. Catches regressions to a plain `{ error: "..." }` body or a
  // type-stripped problem-detail (per project memory
  // `feedback_lock_rfc9457_body_in_tests.md`).
  it("rejection responses follow the full RFC 9457 problem-detail shape", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents/bulk-email-jobs/00000000-0000-0000-0000-000000000bad/resume",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(404);
    const body = res.json<{
      type: string;
      title: string;
      status: number;
      detail: string;
    }>();
    expect(body.type).toMatch(/^https?:\/\//);
    expect(body.title).toBe("job_not_found");
    expect(body.status).toBe(404);
    expect(typeof body.detail).toBe("string");
    expect(body.detail.length).toBeGreaterThan(0);
  });

  // PR #352 review H4: every new admin-gated endpoint must reject `viewer`
  // tokens with 403 — per project memory `feedback_role_test_coverage_both_directions.md`
  // we cover BOTH directions of the boundary (admin-200 above + viewer-403 here).
  it("rejects viewer tokens with 403 on every new bulk-email-jobs endpoint", async () => {
    const viewerToken = signToken(app, {
      role: "viewer",
      realm_access: { roles: ["app-viewer"] },
    });
    // Seed an active `viewer` user row so the auth plugin's active-row
    // check resolves before the role gate fires.
    await seedTenantUser(ORG_A, { role: "viewer" });

    const list = await app.inject({
      method: "GET",
      url: "/v1/constituents/bulk-email-jobs",
      headers: authHeader(viewerToken),
    });
    expect(list.statusCode).toBe(403);

    const get = await app.inject({
      method: "GET",
      url: "/v1/constituents/bulk-email-jobs/00000000-0000-0000-0000-000000000aaa",
      headers: authHeader(viewerToken),
    });
    expect(get.statusCode).toBe(403);

    const resume = await app.inject({
      method: "POST",
      url: "/v1/constituents/bulk-email-jobs/00000000-0000-0000-0000-000000000aaa/resume",
      headers: authHeader(viewerToken),
    });
    expect(resume.statusCode).toBe(403);

    // Re-seed the admin row so subsequent tests in this file regain the
    // org_admin token's active membership.
    await seedTenantUser(ORG_A);
  });

  // PR #352 review H3: a tenant A admin must NOT be able to GET or
  // resume a `bulk_email_jobs` row that belongs to tenant B. RLS makes
  // this safe in the service path; the test is the regression net for
  // anything that ever bypasses `withTenantContext`.
  it("isolates bulk_email_jobs rows across tenants — 404, not 200", async () => {
    // Seed a tenant B row directly. We use raw SQL because seeding via
    // the API would also need a tenant B token, which only complicates
    // the test without exercising the surface we care about.
    const tenantBRow = await db.execute<{ id: string }>(sql`
      INSERT INTO bulk_email_jobs (
        org_id, status, subject, body,
        constituent_ids, total_recipients
      ) VALUES (
        ${ORG_B}::uuid,
        'completed',
        'Tenant B private dispatch',
        'Tenant A must never see this.',
        ARRAY[]::uuid[],
        0
      )
      RETURNING id
    `);
    const tenantBJobId = tenantBRow.rows[0]?.id;
    if (!tenantBJobId) throw new Error("Failed to seed tenant B row");

    const tenantAToken = signToken(app);

    // GET — RLS hides the row, so the API returns 404 (not 403, which
    // would leak existence) — same shape as a missing id.
    const getRes = await app.inject({
      method: "GET",
      url: `/v1/constituents/bulk-email-jobs/${tenantBJobId}`,
      headers: authHeader(tenantAToken),
    });
    expect(getRes.statusCode).toBe(404);

    // Resume — same posture: 404 with code `job_not_found`. A 400
    // `job_still_running` would prove the resume path could see the
    // tenant B row even though it can't write to it.
    const resumeRes = await app.inject({
      method: "POST",
      url: `/v1/constituents/bulk-email-jobs/${tenantBJobId}/resume`,
      headers: authHeader(tenantAToken),
    });
    expect(resumeRes.statusCode).toBe(404);
    expect(resumeRes.json<{ title: string }>().title).toBe("job_not_found");
  });

  // PR #352 review L1 (QA): a deliberately-zero-deliverable dispatch
  // (every selected constituent has no email) must close the row
  // `completed` in the same transaction WITHOUT emitting an outbox
  // event. Exercises the early-return path in `dispatchBulkEmail`.
  it("zero-deliverable dispatch marks the row completed without an outbox event", async () => {
    const token = signToken(app);

    // Count outbox rows of this type before — we'll assert no new rows
    // are added by this dispatch.
    const before = await db.execute<{ c: number }>(sql`
      SELECT count(*)::int AS c FROM outbox_events
      WHERE tenant_id = ${ORG_A}::uuid
        AND type = 'communication.bulk_email_requested'
    `);
    const outboxCountBefore = before.rows[0]?.c ?? 0;

    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents/bulk-email",
      headers: authHeader(token),
      payload: {
        constituentIds: [constituentNoEmailId],
        subject: "Nobody to email",
        body: "But please track the request anyway.",
      },
    });
    expect(res.statusCode).toBe(202);
    const { jobId, queued, skippedNoEmail } = res.json<{
      data: { jobId: string; queued: number; skippedNoEmail: number };
    }>().data;
    expect(queued).toBe(0);
    expect(skippedNoEmail).toBe(1);

    // Row exists and is already `completed` with completed_at set —
    // the operator sees the dispatch in the panel and can move on.
    const trackingRows = await db.execute(sql`
      SELECT status, total_recipients, completed_at
      FROM bulk_email_jobs
      WHERE id = ${jobId}::uuid
    `);
    const tracking = trackingRows.rows[0] as {
      status: string;
      total_recipients: number;
      completed_at: string | null;
    };
    expect(tracking.status).toBe("completed");
    expect(tracking.total_recipients).toBe(0);
    expect(tracking.completed_at).not.toBeNull();

    const after = await db.execute<{ c: number }>(sql`
      SELECT count(*)::int AS c FROM outbox_events
      WHERE tenant_id = ${ORG_A}::uuid
        AND type = 'communication.bulk_email_requested'
    `);
    expect(after.rows[0]?.c ?? 0).toBe(outboxCountBefore);
  });

  // PR #352 review H1: the resume path takes `SELECT ... FOR UPDATE`
  // on the source row, AND migration 0046 enforces a partial unique
  // index on `(parent_job_id) WHERE status IN ('pending', 'processing')`.
  // Even if the row lock is somehow bypassed (raw SQL, future direct-
  // DB tooling), a duplicate INSERT fails at the index layer.
  it("rejects a second active resume from the same parent (partial unique index)", async () => {
    // Seed a partial source.
    const sourceRows = await db.execute<{ id: string }>(sql`
      INSERT INTO bulk_email_jobs (
        org_id, status, subject, body,
        constituent_ids,
        delivered_constituent_ids,
        failed_constituent_ids,
        total_recipients, delivered_count, failed_count
      ) VALUES (
        ${ORG_A}::uuid,
        'partial',
        'Partial source — double resume',
        'First resume should win; second should be blocked.',
        ARRAY[${constituentAId}::uuid, ${constituentBId}::uuid],
        ARRAY[${constituentAId}::uuid],
        ARRAY[]::uuid[],
        2, 1, 0
      )
      RETURNING id
    `);
    const sourceId = sourceRows.rows[0]?.id;
    if (!sourceId) throw new Error("Failed to seed source row");

    // First resume row — should succeed and stay in `pending`.
    const firstResume = await db.execute<{ id: string }>(sql`
      INSERT INTO bulk_email_jobs (
        org_id, status, subject, body,
        constituent_ids, total_recipients,
        parent_job_id
      ) VALUES (
        ${ORG_A}::uuid,
        'pending',
        'First resume',
        'Body.',
        ARRAY[${constituentBId}::uuid],
        1,
        ${sourceId}::uuid
      )
      RETURNING id
    `);
    expect(firstResume.rows.length).toBe(1);

    // Second resume row pointing at the same parent while the first is
    // still non-terminal must fail at the index layer.
    await expect(
      db.execute(sql`
        INSERT INTO bulk_email_jobs (
          org_id, status, subject, body,
          constituent_ids, total_recipients,
          parent_job_id
        ) VALUES (
          ${ORG_A}::uuid,
          'pending',
          'Second resume',
          'Body.',
          ARRAY[${constituentBId}::uuid],
          1,
          ${sourceId}::uuid
        )
      `),
    ).rejects.toThrow();
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
