import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../../server.js";
import { authHeader, ensureTestTenants, signToken } from "../helpers/auth.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();
});

afterAll(async () => {
  await app.close();
});

describe("Core API E2E flow", () => {
  it("covers admin auth, campaign, constituent, donation, and campaign stats update", async () => {
    const token = signToken(app, { role: "org_admin" });
    const headers = authHeader(token);
    const suffix = Date.now().toString();

    const authRes = await app.inject({
      method: "GET",
      url: "/v1/users",
      headers,
    });

    expect(authRes.statusCode).toBe(200);
    expect(authRes.json()).toHaveProperty("data");

    const createCampaignRes = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers,
      payload: {
        name: `E2E Core Flow ${suffix}`,
        type: "digital",
      },
    });

    expect(createCampaignRes.statusCode).toBe(201);
    const campaign = createCampaignRes.json<{
      data: { id: string; name: string; type: string; status: string };
    }>().data;
    expect(campaign.name).toBe(`E2E Core Flow ${suffix}`);
    expect(campaign.type).toBe("digital");
    expect(campaign.status).toBe("draft");

    const createConstituentRes = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers,
      payload: {
        firstName: "E2E",
        lastName: `Donor-${suffix}`,
        email: `e2e-core-flow-${suffix}@example.org`,
        type: "donor",
      },
    });

    expect(createConstituentRes.statusCode).toBe(201);
    const constituent = createConstituentRes.json<{
      data: { id: string; firstName: string; lastName: string };
    }>().data;
    expect(constituent.firstName).toBe("E2E");
    expect(constituent.lastName).toBe(`Donor-${suffix}`);

    const amountCents = 12345;
    const createDonationRes = await app.inject({
      method: "POST",
      url: "/v1/donations",
      headers,
      payload: {
        constituentId: constituent.id,
        campaignId: campaign.id,
        amountCents,
        currency: "EUR",
        paymentMethod: "check",
        paymentRef: `E2E-${suffix}`,
      },
    });

    expect(createDonationRes.statusCode).toBe(201);
    const donation = createDonationRes.json<{
      data: { id: string; amountCents: number; campaignId: string; constituentId: string };
    }>().data;
    expect(donation.amountCents).toBe(amountCents);
    expect(donation.campaignId).toBe(campaign.id);
    expect(donation.constituentId).toBe(constituent.id);

    const statsRes = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${campaign.id}/stats`,
      headers,
    });

    expect(statsRes.statusCode).toBe(200);
    expect(statsRes.json()).toEqual({
      data: {
        campaignId: campaign.id,
        totalRaisedCents: amountCents,
        donationCount: 1,
        uniqueDonors: 1,
      },
    });
  });
});
