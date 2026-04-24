import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";
import { createServer } from "../../server.js";
import {
  authHeader,
  ensureTestTenants,
  ORG_A,
  ORG_B,
  signToken,
  signTokenB,
} from "../helpers/auth.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();
  // Fresh slate for funds — issue #56 Data #13 added `UNIQUE(org_id, name)`
  // so re-running the suite against a persistent DB without cleanup hits
  // duplicates on every POST. Delete both tenants' funds here so each test
  // run starts predictable. Cascade handles campaign_funds / donations.
  await db.execute(sql`DELETE FROM campaign_funds WHERE org_id IN (${ORG_A}, ${ORG_B})`);
  await db.execute(sql`DELETE FROM donation_allocations WHERE org_id IN (${ORG_A}, ${ORG_B})`);
  await db.execute(sql`DELETE FROM funds WHERE org_id IN (${ORG_A}, ${ORG_B})`);
});

afterAll(async () => {
  await app.close();
});

describe("Funds CRUD", () => {
  let fundId: string;

  it("POST /v1/funds creates a restricted fund", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/funds",
      headers: authHeader(token),
      payload: {
        name: "Capital Campaign Fund",
        description: "Restricted to capital expenditures",
        type: "restricted",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{
      data: { id: string; name: string; description: string | null; type: string };
    }>();
    expect(body.data.name).toBe("Capital Campaign Fund");
    expect(body.data.description).toBe("Restricted to capital expenditures");
    expect(body.data.type).toBe("restricted");
    fundId = body.data.id;
  });

  it("GET /v1/funds lists tenant funds", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/funds",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ id: string }>; pagination: { total: number } }>();
    expect(body.data.some((fund) => fund.id === fundId)).toBe(true);
    expect(body.pagination.total).toBeGreaterThanOrEqual(1);
  });

  it("GET /v1/funds/:id returns one fund", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/funds/${fundId}`,
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { id: string; name: string } }>();
    expect(body.data.id).toBe(fundId);
    expect(body.data.name).toBe("Capital Campaign Fund");
  });

  it("PATCH /v1/funds/:id updates a fund", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/funds/${fundId}`,
      headers: authHeader(token),
      payload: {
        name: "Capital Projects Fund",
        description: null,
        type: "unrestricted",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { name: string; description: string | null; type: string } }>();
    expect(body.data.name).toBe("Capital Projects Fund");
    expect(body.data.description).toBeNull();
    expect(body.data.type).toBe("unrestricted");
  });

  it("DELETE /v1/funds/:id deletes an unused fund", async () => {
    const token = signToken(app);
    const createRes = await app.inject({
      method: "POST",
      url: "/v1/funds",
      headers: authHeader(token),
      payload: {
        name: "To Delete",
        type: "restricted",
      },
    });
    const deletableFundId = createRes.json<{ data: { id: string } }>().data.id;

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/funds/${deletableFundId}`,
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { id: string } }>();
    expect(body.data.id).toBe(deletableFundId);
  });

  it("DELETE /v1/funds/:id rejects deleting a fund used by a donation allocation", async () => {
    const token = signToken(app);

    const constituentRes = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(token),
      payload: { firstName: "Funds", lastName: "Donor", type: "donor" },
    });
    const constituentId = constituentRes.json<{ data: { id: string } }>().data.id;

    const fundRes = await app.inject({
      method: "POST",
      url: "/v1/funds",
      headers: authHeader(token),
      payload: { name: "Allocated Fund", type: "restricted" },
    });
    const allocatedFundId = fundRes.json<{ data: { id: string } }>().data.id;

    const donationRes = await app.inject({
      method: "POST",
      url: "/v1/donations",
      headers: authHeader(token),
      payload: {
        constituentId,
        amountCents: 1500,
        allocations: [{ fundId: allocatedFundId, amountCents: 1500 }],
      },
    });

    expect(donationRes.statusCode).toBe(201);

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/funds/${allocatedFundId}`,
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(409);
    const body = res.json<{ detail: string }>();
    expect(body.detail).toContain("donation allocations");
  });
});

describe("Campaign fund linkage", () => {
  it("creates, updates, and lists eligible campaign funds", async () => {
    const token = signToken(app);

    const fundARes = await app.inject({
      method: "POST",
      url: "/v1/funds",
      headers: authHeader(token),
      payload: { name: "Education Fund", type: "restricted" },
    });
    const fundAId = fundARes.json<{ data: { id: string } }>().data.id;

    const fundBRes = await app.inject({
      method: "POST",
      url: "/v1/funds",
      headers: authHeader(token),
      payload: { name: "General Operating Fund", type: "unrestricted" },
    });
    const fundBId = fundBRes.json<{ data: { id: string } }>().data.id;

    const createCampaignRes = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: authHeader(token),
      payload: {
        name: "Funds-Linked Campaign",
        type: "digital",
        fundIds: [fundAId, fundBId],
      },
    });

    expect(createCampaignRes.statusCode).toBe(201);
    const campaignId = createCampaignRes.json<{ data: { id: string } }>().data.id;

    const listRes = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${campaignId}/funds`,
      headers: authHeader(token),
    });

    expect(listRes.statusCode).toBe(200);
    const listBody = listRes.json<{ data: Array<{ id: string }> }>();
    expect(listBody.data.map((fund) => fund.id).sort()).toEqual([fundAId, fundBId].sort());

    const updateRes = await app.inject({
      method: "PATCH",
      url: `/v1/campaigns/${campaignId}`,
      headers: authHeader(token),
      payload: { fundIds: [fundBId] },
    });

    expect(updateRes.statusCode).toBe(200);

    const updatedListRes = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${campaignId}/funds`,
      headers: authHeader(token),
    });

    expect(updatedListRes.statusCode).toBe(200);
    const updatedListBody = updatedListRes.json<{ data: Array<{ id: string }> }>();
    expect(updatedListBody.data.map((fund) => fund.id)).toEqual([fundBId]);
  });

  it("rejects linking a campaign to a fund from another tenant", async () => {
    const tokenA = signToken(app);
    const tokenB = signTokenB(app);

    const fundRes = await app.inject({
      method: "POST",
      url: "/v1/funds",
      headers: authHeader(tokenB),
      payload: { name: "Org B Restricted Fund", type: "restricted" },
    });
    const fundId = fundRes.json<{ data: { id: string } }>().data.id;

    const campaignRes = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: authHeader(tokenA),
      payload: { name: "Cross-Tenant Fund Link", type: "digital" },
    });
    const campaignId = campaignRes.json<{ data: { id: string } }>().data.id;

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/campaigns/${campaignId}`,
      headers: authHeader(tokenA),
      payload: { fundIds: [fundId] },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ detail: string }>();
    expect(body.detail).toContain("funds were not found");
  });

  it("cascades campaign_funds rows when a campaign or fund is deleted", async () => {
    const token = signToken(app);

    const fundRes = await app.inject({
      method: "POST",
      url: "/v1/funds",
      headers: authHeader(token),
      payload: { name: "Cascade Fund", type: "restricted" },
    });
    const fundId = fundRes.json<{ data: { id: string } }>().data.id;

    const campaignRes = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: authHeader(token),
      payload: { name: "Cascade Campaign", type: "digital", fundIds: [fundId] },
    });
    const campaignId = campaignRes.json<{ data: { id: string } }>().data.id;

    const beforeDelete = await db.execute(
      sql`SELECT count(*)::int AS count FROM campaign_funds WHERE campaign_id = ${campaignId} AND fund_id = ${fundId}`,
    );
    expect(beforeDelete.rows[0]?.count).toBe(1);

    await db.execute(sql`DELETE FROM campaigns WHERE id = ${campaignId}`);

    const afterCampaignDelete = await db.execute(
      sql`SELECT count(*)::int AS count FROM campaign_funds WHERE campaign_id = ${campaignId} AND fund_id = ${fundId}`,
    );
    expect(afterCampaignDelete.rows[0]?.count).toBe(0);

    const campaignRes2 = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: authHeader(token),
      payload: { name: "Cascade Campaign 2", type: "digital", fundIds: [fundId] },
    });
    const campaignId2 = campaignRes2.json<{ data: { id: string } }>().data.id;

    const beforeFundDelete = await db.execute(
      sql`SELECT count(*)::int AS count FROM campaign_funds WHERE campaign_id = ${campaignId2} AND fund_id = ${fundId}`,
    );
    expect(beforeFundDelete.rows[0]?.count).toBe(1);

    await db.execute(sql`DELETE FROM funds WHERE id = ${fundId}`);

    const afterFundDelete = await db.execute(
      sql`SELECT count(*)::int AS count FROM campaign_funds WHERE campaign_id = ${campaignId2} AND fund_id = ${fundId}`,
    );
    expect(afterFundDelete.rows[0]?.count).toBe(0);
  });
});
