/**
 * Issue #611 items 6 + 7 — write paths that used to surface as 500:
 *   • PATCH /v1/donations/:id with an unknown / cross-tenant campaign → 404
 *   • unique violations → 409 (donation payment ref, fund name, user email,
 *     tenant slug)
 *
 * Every conflict body is also checked for SQL leakage: the constraint is
 * mapped in the route, so the raw `Failed query: …` text must never appear.
 */

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../../server.js";
import { authHeader, ensureTestTenants, signToken, signTokenB } from "../helpers/auth.js";

let app: FastifyInstance;
let tokenA: string;
let constituentId: string;

// Unique per run — the suite is re-runnable against a persistent DB.
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

function expectConflict(res: { statusCode: number; body: string; json: () => unknown }) {
  expect(res.statusCode).toBe(409);
  const body = res.json() as { status: number; title: string };
  expect(body.status).toBe(409);
  expect(body.title).toBe("Conflict");
  expect(res.body).not.toContain("Failed query");
  expect(res.body).not.toContain("params:");
}

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();
  tokenA = signToken(app);

  const res = await app.inject({
    method: "POST",
    url: "/v1/constituents?force=true",
    headers: authHeader(tokenA),
    payload: { firstName: "Conflict", lastName: `Donor ${RUN}`, type: "donor" },
  });
  constituentId = res.json<{ data: { id: string } }>().data.id;
});

afterAll(async () => {
  await app.close();
});

describe("PATCH /v1/donations/:id reference errors (issue #611 item 6)", () => {
  let donationId: string;

  beforeAll(async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/donations",
      headers: authHeader(tokenA),
      payload: { constituentId, amountCents: 2500 },
    });
    expect(res.statusCode).toBe(201);
    donationId = res.json<{ data: { id: string } }>().data.id;
  });

  it("returns 404 for an unknown campaignId", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/donations/${donationId}`,
      headers: authHeader(tokenA),
      payload: {
        constituentId,
        amountCents: 2500,
        campaignId: "00000000-0000-0000-0000-00000000dead",
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for another tenant's campaign", async () => {
    const campaignRes = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: authHeader(signTokenB(app)),
      payload: { name: `Org B campaign ${RUN}`, type: "digital" },
    });
    expect(campaignRes.statusCode).toBe(201);
    const orgBCampaignId = campaignRes.json<{ data: { id: string } }>().data.id;

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/donations/${donationId}`,
      headers: authHeader(tokenA),
      payload: { constituentId, amountCents: 2500, campaignId: orgBCampaignId },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for an unknown fund in allocations", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/donations/${donationId}`,
      headers: authHeader(tokenA),
      payload: {
        constituentId,
        amountCents: 2500,
        allocations: [{ fundId: "00000000-0000-0000-0000-00000000dead", amountCents: 2500 }],
      },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("unique violations map to 409 (issue #611 item 7)", () => {
  it("POST /v1/donations — duplicate (paymentMethod, paymentRef)", async () => {
    const payload = {
      constituentId,
      amountCents: 1000,
      paymentMethod: "check",
      paymentRef: `CHQ-${RUN}`,
    };
    const first = await app.inject({
      method: "POST",
      url: "/v1/donations",
      headers: authHeader(tokenA),
      payload,
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: "/v1/donations",
      headers: authHeader(tokenA),
      payload,
    });
    expectConflict(second);
  });

  it("PATCH /v1/donations/:id — payment ref collides with another donation", async () => {
    const taken = await app.inject({
      method: "POST",
      url: "/v1/donations",
      headers: authHeader(tokenA),
      payload: {
        constituentId,
        amountCents: 1000,
        paymentMethod: "check",
        paymentRef: `CHQ-TAKEN-${RUN}`,
      },
    });
    expect(taken.statusCode).toBe(201);

    const other = await app.inject({
      method: "POST",
      url: "/v1/donations",
      headers: authHeader(tokenA),
      payload: {
        constituentId,
        amountCents: 1000,
        paymentMethod: "check",
        paymentRef: `CHQ-OTHER-${RUN}`,
      },
    });
    const otherId = other.json<{ data: { id: string } }>().data.id;

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/donations/${otherId}`,
      headers: authHeader(tokenA),
      payload: {
        constituentId,
        amountCents: 1000,
        paymentMethod: "check",
        paymentRef: `CHQ-TAKEN-${RUN}`,
      },
    });
    expectConflict(res);
  });

  it("POST + PATCH /v1/funds — duplicate name", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/v1/funds",
      headers: authHeader(tokenA),
      payload: { name: `Fund One ${RUN}` },
    });
    expect(first.statusCode).toBe(201);

    const dup = await app.inject({
      method: "POST",
      url: "/v1/funds",
      headers: authHeader(tokenA),
      payload: { name: `Fund One ${RUN}` },
    });
    expectConflict(dup);

    const second = await app.inject({
      method: "POST",
      url: "/v1/funds",
      headers: authHeader(tokenA),
      payload: { name: `Fund Two ${RUN}` },
    });
    expect(second.statusCode).toBe(201);
    const secondId = second.json<{ data: { id: string } }>().data.id;

    const rename = await app.inject({
      method: "PATCH",
      url: `/v1/funds/${secondId}`,
      headers: authHeader(tokenA),
      payload: { name: `Fund One ${RUN}` },
    });
    expectConflict(rename);
  });

  it("POST /v1/users — duplicate email within the org", async () => {
    const payload = {
      email: `dup-${RUN}@example.org`,
      firstName: "Dup",
      lastName: "User",
    };
    const first = await app.inject({
      method: "POST",
      url: "/v1/users",
      headers: authHeader(tokenA),
      payload,
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: "/v1/users",
      headers: authHeader(tokenA),
      payload,
    });
    expectConflict(second);
    // The bound email must not be reflected back via a raw query error.
    expect(second.body).not.toContain("insert into");
  });

  it("POST /v1/tenants — duplicate slug", async () => {
    const headers = { "x-admin-secret": process.env["ADMIN_SECRET"] ?? "" };
    const slug = `dup-slug-${RUN}`;
    const first = await app.inject({
      method: "POST",
      url: "/v1/tenants",
      headers,
      payload: { name: "Dup Slug Org", slug },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: "/v1/tenants",
      headers,
      payload: { name: "Dup Slug Org 2", slug },
    });
    expectConflict(second);
  });
});
