import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../../server.js";
import { authHeader, ensureTestTenants, signToken } from "../helpers/auth.js";

describe("GET /v1/donations/:id reproduction", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createServer();
    await ensureTestTenants();
  });

  afterAll(async () => {
    await app.close();
  });
  it("should return the donation even if the constituent is soft-deleted", async () => {
    const token = signToken(app);
    // Create constituent
    const res1 = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(token),
      payload: { firstName: "TestRepro", lastName: "DonorRepro" },
    });
    const constituentId = res1.json().data?.id || res1.json().id;

    // Create donation
    const res2 = await app.inject({
      method: "POST",
      url: "/v1/donations",
      headers: authHeader(token),
      payload: { constituentId, amountCents: 5000, currency: "EUR" },
    });
    const donationId = res2.json().data?.id || res2.json().id;

    // Delete constituent
    await app.inject({
      method: "DELETE",
      url: `/v1/constituents/${constituentId}`,
      headers: authHeader(token),
    });

    // Get donation
    const res3 = await app.inject({
      method: "GET",
      url: `/v1/donations/${donationId}`,
      headers: authHeader(token),
    });
    expect(res3.statusCode).toBe(200);
  });
});
