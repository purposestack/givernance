/**
 * Step-up ACR guard integration tests for bank account mutations (Epic #416, Task 13).
 *
 * The `requireBankMutationAcr` guard (in lib/guards.ts) fires on
 * POST / PATCH / DELETE /v1/bank-accounts. It requires:
 *   1. acr === "urn:givernance:acr:bank-mutation" in the JWT
 *   2. auth_time within the last 900 seconds (15 minutes)
 *
 * GET /v1/bank-accounts does NOT require the step-up — only requireAuth.
 *
 * On failure the response includes a `WWW-Authenticate` header.
 */

import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";
import { createServer } from "../../server.js";
import { authHeader, ensureTestTenants, ORG_A, signToken } from "../helpers/auth.js";

let app: FastifyInstance;

const ACR_CLAIM = "urn:givernance:acr:bank-mutation";
const STEP_UP_WINDOW_SECONDS = 900;

const VALID_CH_IBAN = "CH4808390000012345678";

const MINIMAL_BANK_ACCOUNT_PAYLOAD = {
  label: "Step-up Test Account",
  holderName: "Association Step-Up Test",
  holderStreet: "Rue de Step Up",
  holderBuildingNumber: "1",
  holderPostalCode: "1000",
  holderTown: "Lausanne",
  holderCountryCode: "CH",
  iban: VALID_CH_IBAN,
  currency: "CHF",
};

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();

  // Clean up to avoid IBAN uniqueness collision on re-runs
  await db.execute(
    sql`DELETE FROM bank_accounts WHERE org_id = ${ORG_A} AND label = 'Step-up Test Account'`,
  );
});

afterAll(async () => {
  await app.close();
});

describe("Step-up ACR guard on bank account mutations (Task 13)", () => {
  it("GET /v1/bank-accounts does NOT require ACR → 200", async () => {
    // Standard token with no acr claim
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/bank-accounts",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
  });

  it("POST /v1/bank-accounts WITHOUT ACR → 401 with WWW-Authenticate header", async () => {
    // Token has no acr claim at all
    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/bank-accounts",
      headers: authHeader(token),
      payload: MINIMAL_BANK_ACCOUNT_PAYLOAD,
    });

    expect(res.statusCode).toBe(401);
    // The guard must set the WWW-Authenticate header
    expect(res.headers["www-authenticate"]).toMatch(/urn:givernance:acr:bank-mutation/);
    const body = res.json<{ type: string }>();
    expect(body.type).toBe("urn:givernance:error:step-up-required");
  });

  it("POST /v1/bank-accounts WITH correct ACR but stale auth_time (>900s) → 401", async () => {
    const staleAuthTime = Math.floor(Date.now() / 1000) - (STEP_UP_WINDOW_SECONDS + 60);
    const token = signToken(app, {
      acr: ACR_CLAIM,
      auth_time: staleAuthTime,
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/bank-accounts",
      headers: authHeader(token),
      payload: MINIMAL_BANK_ACCOUNT_PAYLOAD,
    });

    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toMatch(/urn:givernance:acr:bank-mutation/);
    const body = res.json<{ type: string }>();
    expect(body.type).toBe("urn:givernance:error:step-up-required");
  });

  it("POST /v1/bank-accounts WITH correct ACR and recent auth_time → passes step-up (201 or next guard error)", async () => {
    const recentAuthTime = Math.floor(Date.now() / 1000) - 60; // 1 minute ago — well within 900s
    const token = signToken(app, {
      acr: ACR_CLAIM,
      auth_time: recentAuthTime,
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/bank-accounts",
      headers: authHeader(token),
      payload: MINIMAL_BANK_ACCOUNT_PAYLOAD,
    });

    // The step-up guard passed — should be 201 (success) or any other non-401 error
    // (e.g. if the IBAN is rejected, we get 400; if role check fails for some env, 403).
    // The critical assertion is: NOT 401 with step-up-required type.
    if (res.statusCode === 401) {
      const body = res.json<{ type?: string }>();
      expect(body.type).not.toBe("urn:givernance:error:step-up-required");
    } else {
      expect(res.statusCode).toBe(201);
    }
  });

  it("POST /v1/bank-accounts with wrong ACR value → 401", async () => {
    const token = signToken(app, {
      acr: "urn:givernance:acr:wrong-value",
      auth_time: Math.floor(Date.now() / 1000) - 60,
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/bank-accounts",
      headers: authHeader(token),
      payload: MINIMAL_BANK_ACCOUNT_PAYLOAD,
    });

    expect(res.statusCode).toBe(401);
    const body = res.json<{ type: string }>();
    expect(body.type).toBe("urn:givernance:error:step-up-required");
  });
});
