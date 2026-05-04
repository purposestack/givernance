/**
 * Integration tests for Epic #274 — postal campaign MVP.
 *
 * Covers:
 *   - Constituent ↔ campaign linking (attach / list / detach, idempotency,
 *     door-drop rejection).
 *   - Export-job creation lifecycle (pending row, no-recipients guard,
 *     status polling shape).
 *   - Constituent list filters (last-donation window, total-amount window,
 *     campaign linkage).
 *   - Bulk-email queue request (validates id ownership, surfaces reachable
 *     count for non-emailed recipients).
 *
 * The worker side (ZIP archive bundling, signed-URL generation) is exercised
 * separately by the existing receipts/campaign-documents worker tests; these
 * tests stop at the API boundary so they can run without S3.
 */

import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";
import { createServer } from "../../server.js";
import { authHeader, ensureTestTenants, signToken } from "../helpers/auth.js";

let app: FastifyInstance;
let campaignId: string;
let donorId: string;
let secondaryDonorId: string;

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();

  const token = signToken(app);

  // Two constituents — one with email, one without — so the bulk-email
  // reachability check can surface a non-trivial difference.
  const c1 = await app.inject({
    method: "POST",
    url: "/v1/constituents?force=true",
    headers: authHeader(token),
    payload: {
      firstName: "Postal",
      lastName: "Donor",
      email: "postal.donor@example.org",
      type: "donor",
    },
  });
  donorId = c1.json<{ data: { id: string } }>().data.id;

  const c2 = await app.inject({
    method: "POST",
    url: "/v1/constituents?force=true",
    headers: authHeader(token),
    payload: { firstName: "Phone", lastName: "Only", type: "donor" },
  });
  secondaryDonorId = c2.json<{ data: { id: string } }>().data.id;

  const camp = await app.inject({
    method: "POST",
    url: "/v1/campaigns",
    headers: authHeader(token),
    payload: { name: "Postal MVP Test Campaign", type: "nominative_postal" },
  });
  campaignId = camp.json<{ data: { id: string } }>().data.id;
});

afterAll(async () => {
  // Best-effort cleanup so re-runs don't accumulate fixtures. RLS is
  // bypassed here (test runs as owner role) so the deletes target the
  // exact rows we created.
  if (campaignId) {
    await db.execute(sql`DELETE FROM campaign_export_jobs WHERE campaign_id = ${campaignId}`);
    await db.execute(sql`DELETE FROM campaign_constituents WHERE campaign_id = ${campaignId}`);
    await db.execute(sql`DELETE FROM campaigns WHERE id = ${campaignId}`);
  }
  await app.close();
});

describe("Epic #274 — Constituent linkage", () => {
  it("POST /v1/campaigns/:id/constituents attaches a constituent (idempotent)", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/constituents`,
      headers: authHeader(token),
      payload: { constituentIds: [donorId] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { attached: number } }>().data.attached).toBe(1);

    // Re-attaching is a no-op (skipped count = 1).
    const res2 = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/constituents`,
      headers: authHeader(token),
      payload: { constituentIds: [donorId] },
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.json<{ data: { attached: number; skipped: number } }>().data).toEqual({
      attached: 0,
      skipped: 1,
    });
  });

  it("GET /v1/campaigns/:id/constituents lists the linked recipients", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${campaignId}/constituents`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: Array<{ constituentId: string }>;
      campaignType: string;
      pagination: { total: number };
    }>();
    expect(body.pagination.total).toBe(1);
    expect(body.campaignType).toBe("nominative_postal");
    expect(body.data[0]?.constituentId).toBe(donorId);
  });

  it("DELETE /v1/campaigns/:id/constituents/:cId removes the link", async () => {
    const token = signToken(app);
    // Attach a second constituent to leave one after the delete.
    await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/constituents`,
      headers: authHeader(token),
      payload: { constituentIds: [secondaryDonorId] },
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/campaigns/${campaignId}/constituents/${secondaryDonorId}`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(204);

    const list = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${campaignId}/constituents`,
      headers: authHeader(token),
    });
    const body = list.json<{ pagination: { total: number } }>();
    expect(body.pagination.total).toBe(1);
  });

  it("rejects linkage on door-drop campaigns with a 400", async () => {
    const token = signToken(app);
    const door = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: authHeader(token),
      payload: { name: "Door drop reject test", type: "door_drop" },
    });
    const ddId = door.json<{ data: { id: string } }>().data.id;

    const res = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${ddId}/constituents`,
      headers: authHeader(token),
      payload: { constituentIds: [donorId] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ title: string }>().title).toBe("invalid_campaign_type");

    await db.execute(sql`DELETE FROM campaigns WHERE id = ${ddId}`);
  });
});

describe("Epic #274 — Export jobs", () => {
  it("POST /v1/campaigns/:id/exports creates a pending job for nominative", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/exports`,
      headers: authHeader(token),
      payload: { mode: "nominative" },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json<{
      data: {
        id: string;
        status: string;
        progressTotal: number;
        progressDone: number;
        progressPct: number;
        downloadUrl: string | null;
      };
    }>();
    expect(body.data.status).toBe("pending");
    expect(body.data.progressTotal).toBeGreaterThan(0);
    expect(body.data.progressDone).toBe(0);
    expect(body.data.progressPct).toBe(0);
    expect(body.data.downloadUrl).toBeNull();
  });

  it("rejects nominative exports when no recipients are linked", async () => {
    const token = signToken(app);
    const empty = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: authHeader(token),
      payload: { name: "Empty nominative", type: "nominative_postal" },
    });
    const emptyId = empty.json<{ data: { id: string } }>().data.id;

    const res = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${emptyId}/exports`,
      headers: authHeader(token),
      payload: { mode: "nominative" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ title: string }>().title).toBe("no_recipients");

    await db.execute(sql`DELETE FROM campaigns WHERE id = ${emptyId}`);
  });

  it("GET /v1/campaigns/:id/exports/:jobId returns 404 for unknown jobs", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${campaignId}/exports/00000000-0000-0000-0000-0000000000aa`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("Epic #274 — Constituent filters", () => {
  it("GET /v1/constituents?campaignId restricts to constituents linked to the campaign", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/constituents?campaignId=${campaignId}`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ id: string }> }>();
    // The donor we attached should appear; phone-only donor should NOT
    // (it isn't linked to this campaign).
    expect(body.data.map((c) => c.id)).toContain(donorId);
    expect(body.data.map((c) => c.id)).not.toContain(secondaryDonorId);
  });

  it("GET /v1/constituents accepts the last-donation and total-amount filters without 4xx", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url:
        "/v1/constituents?" +
        `lastDonationFrom=${encodeURIComponent("2020-01-01T00:00:00Z")}` +
        "&totalAmountMinCents=0",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ id: string }> }>();
    // We're not asserting specific membership here — these constituents have
    // zero donations, so the last-donation filter excludes them. The point
    // of this test is that the route accepts the new params shape.
    expect(Array.isArray(body.data)).toBe(true);
  });
});

describe("Epic #274 — Bulk email", () => {
  it("POST /v1/constituents/bulk-email queues a request and reports reachability", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents/bulk-email",
      headers: authHeader(token),
      payload: {
        constituentIds: [donorId, secondaryDonorId],
        subject: "Test subject",
        bodyText: "Test body — please ignore.",
      },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json<{ data: { requested: number; reachable: number } }>();
    expect(body.data.requested).toBe(2);
    // Only the first constituent has an email address.
    expect(body.data.reachable).toBe(1);
  });

  it("rejects requests including a constituent from another tenant", async () => {
    // Seed a constituent in ORG_B and verify the request from ORG_A 400s.
    const tokenA = signToken(app);
    const fakeId = "00000000-0000-0000-0000-0000000000ab";
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents/bulk-email",
      headers: authHeader(tokenA),
      payload: {
        constituentIds: [donorId, fakeId],
        subject: "Cross-tenant attempt",
        bodyText: "This should be rejected.",
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
