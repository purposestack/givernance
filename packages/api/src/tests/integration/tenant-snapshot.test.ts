import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";
import { createServer } from "../../server.js";
import { authHeader, ensureTestTenants, signToken, signTokenB } from "../helpers/auth.js";

let app: FastifyInstance;
const SNAPSHOT_ORG = "00000000-0000-0000-0000-000000000123";

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug)
        VALUES (${SNAPSHOT_ORG}, 'Snapshot Org', 'snapshot-org')
        ON CONFLICT (id) DO NOTHING`,
  );
});

afterAll(async () => {
  await app.close();
});

describe("Tenant snapshot export", () => {
  it("GET /v1/admin/tenants/:orgId/snapshot exports campaigns, constituents, and donations for the owning org admin", async () => {
    const tokenA = signToken(app, { org_id: SNAPSHOT_ORG });

    const constituentRes = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(tokenA),
      payload: {
        firstName: "Snapshot",
        lastName: "Donor",
        email: `snapshot-${Date.now()}@example.org`,
        type: "donor",
      },
    });
    expect(constituentRes.statusCode).toBe(201);
    const constituentId = constituentRes.json<{ data: { id: string } }>().data.id;

    const campaignRes = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: authHeader(tokenA),
      payload: {
        name: `Snapshot Campaign ${Date.now()}`,
        type: "digital",
      },
    });
    expect(campaignRes.statusCode).toBe(201);
    const campaignId = campaignRes.json<{ data: { id: string } }>().data.id;

    const donationRes = await app.inject({
      method: "POST",
      url: "/v1/donations",
      headers: authHeader(tokenA),
      payload: {
        constituentId,
        campaignId,
        amountCents: 4200,
        currency: "EUR",
        paymentMethod: "bank_transfer",
        paymentRef: `SNAP-${Date.now()}-${Math.random()}`,
      },
    });
    expect(donationRes.statusCode).toBe(201);
    const donationId = donationRes.json<{ data: { id: string } }>().data.id;

    const snapshotRes = await app.inject({
      method: "GET",
      url: `/v1/admin/tenants/${SNAPSHOT_ORG}/snapshot`,
      headers: authHeader(tokenA),
    });

    expect(snapshotRes.statusCode).toBe(200);
    const body = snapshotRes.json<{
      data: {
        orgId: string;
        exportedAt: string;
        campaigns: Array<{ id: string; orgId: string }>;
        constituents: Array<{ id: string; orgId: string }>;
        donations: Array<{
          id: string;
          orgId: string;
          constituentId: string;
          campaignId: string | null;
        }>;
      };
    }>();

    expect(body.data.orgId).toBe(SNAPSHOT_ORG);
    expect(body.data.exportedAt).toBeTruthy();
    expect(
      body.data.campaigns.some(
        (campaign) => campaign.id === campaignId && campaign.orgId === SNAPSHOT_ORG,
      ),
    ).toBe(true);
    expect(
      body.data.constituents.some(
        (constituent) => constituent.id === constituentId && constituent.orgId === SNAPSHOT_ORG,
      ),
    ).toBe(true);
    expect(
      body.data.donations.some(
        (donation) =>
          donation.id === donationId &&
          donation.orgId === SNAPSHOT_ORG &&
          donation.constituentId === constituentId &&
          donation.campaignId === campaignId,
      ),
    ).toBe(true);
  });

  it("forbids an org admin from exporting another tenant's snapshot", async () => {
    const tokenB = signTokenB(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/admin/tenants/${SNAPSHOT_ORG}/snapshot`,
      headers: authHeader(tokenB),
    });

    expect(res.statusCode).toBe(403);
  });

  it("allows a super_admin to export another tenant's snapshot", async () => {
    const superAdminToken = signTokenB(app, {
      role: "viewer",
      realm_access: { roles: ["super_admin"] },
    });

    const res = await app.inject({
      method: "GET",
      url: `/v1/admin/tenants/${SNAPSHOT_ORG}/snapshot`,
      headers: authHeader(superAdminToken),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { orgId: string } }>().data.orgId).toBe(SNAPSHOT_ORG);
  });
});
