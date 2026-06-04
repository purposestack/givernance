/**
 * Fund ↔ bank account FK integration tests (Epic #416, Task 3).
 *
 * Verifies that PATCH /v1/funds/:id correctly:
 *   - Persists a bankAccountId link when a valid active same-org account is given
 *   - Rejects a cross-org bankAccountId with 404
 *   - Rejects an inactive bank account with 422
 *   - Clears the FK when bankAccountId = null (unlink)
 */

import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../../server.js";
import {
  authHeader,
  ensureTestTenants,
  ORG_A,
  ORG_B,
  signToken,
  signTokenB,
} from "../helpers/auth.js";
import { db } from "../helpers/db.js";

let app: FastifyInstance;

const VALID_CH_IBAN_A = "CH5604835012345678009";
const VALID_CH_IBAN_B = "CH9300762011623852957";
const VALID_CH_IBAN_INACTIVE = "CH4431999123000889012";

const BASE_HOLDER = {
  holderName: "Association Givernance Test (Task 3)",
  holderStreet: "Rue du Test",
  holderBuildingNumber: "1",
  holderPostalCode: "1000",
  holderTown: "Lausanne",
  holderCountryCode: "CH",
};

let bankAccountA: string;
let bankAccountB: string;
let inactiveBankAccountA: string;
let fundA: string;

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();

  // Clean up to avoid collisions on re-runs
  await db.execute(sql`DELETE FROM campaign_funds WHERE org_id IN (${ORG_A}, ${ORG_B})`);
  // donation_allocations has a FK to funds — clear it first to avoid constraint violation
  await db.execute(
    sql`DELETE FROM donation_allocations WHERE fund_id IN (SELECT id FROM funds WHERE org_id IN (${ORG_A}, ${ORG_B}))`,
  );
  await db.execute(sql`DELETE FROM funds WHERE org_id IN (${ORG_A}, ${ORG_B})`);
  await db.execute(sql`DELETE FROM bank_accounts WHERE org_id IN (${ORG_A}, ${ORG_B})`);

  const tokenA = signToken(app, {
    acr: "urn:givernance:acr:bank-mutation",
    auth_time: Math.floor(Date.now() / 1000) - 60,
  });

  // Create an active bank account for ORG_A
  const createA = await app.inject({
    method: "POST",
    url: "/v1/bank-accounts",
    headers: authHeader(tokenA),
    payload: {
      ...BASE_HOLDER,
      label: "PostFinance CHF (ORG_A)",
      iban: VALID_CH_IBAN_A,
      currency: "CHF",
    },
  });
  expect(createA.statusCode).toBe(201);
  bankAccountA = createA.json<{ data: { id: string } }>().data.id;

  // Create an active bank account for ORG_B (for cross-org test)
  const tokenB = signTokenB(app, {
    acr: "urn:givernance:acr:bank-mutation",
    auth_time: Math.floor(Date.now() / 1000) - 60,
  });
  const createB = await app.inject({
    method: "POST",
    url: "/v1/bank-accounts",
    headers: authHeader(tokenB),
    payload: {
      ...BASE_HOLDER,
      label: "PostFinance CHF (ORG_B)",
      iban: VALID_CH_IBAN_B,
      currency: "CHF",
    },
  });
  expect(createB.statusCode).toBe(201);
  bankAccountB = createB.json<{ data: { id: string } }>().data.id;

  // Create and deactivate a bank account for the inactive test
  const createInactive = await app.inject({
    method: "POST",
    url: "/v1/bank-accounts",
    headers: authHeader(tokenA),
    payload: {
      ...BASE_HOLDER,
      label: "QR-IBAN (to deactivate)",
      iban: VALID_CH_IBAN_INACTIVE,
      currency: "CHF",
    },
  });
  expect(createInactive.statusCode).toBe(201);
  inactiveBankAccountA = createInactive.json<{ data: { id: string } }>().data.id;

  // Deactivate it via PATCH
  const deactivate = await app.inject({
    method: "PATCH",
    url: `/v1/bank-accounts/${inactiveBankAccountA}`,
    headers: authHeader(tokenA),
    payload: { isActive: false },
  });
  expect(deactivate.statusCode).toBe(200);

  // Create a fund for ORG_A (no bankAccountId initially)
  const createFund = await app.inject({
    method: "POST",
    url: "/v1/funds",
    headers: authHeader(signToken(app)),
    payload: { name: "General Fund (Task 3 test)", type: "unrestricted" },
  });
  expect(createFund.statusCode).toBe(201);
  fundA = createFund.json<{ data: { id: string } }>().data.id;
});

afterAll(async () => {
  // Clean up so subsequent test files don't inherit stale bank accounts / funds
  // that would cause FK or duplicate-IBAN conflicts.
  await db.execute(sql`DELETE FROM campaign_funds WHERE org_id IN (${ORG_A}, ${ORG_B})`);
  await db.execute(
    sql`DELETE FROM donation_allocations WHERE fund_id IN (SELECT id FROM funds WHERE org_id IN (${ORG_A}, ${ORG_B}))`,
  );
  await db.execute(sql`DELETE FROM funds WHERE org_id IN (${ORG_A}, ${ORG_B})`);
  await db.execute(sql`DELETE FROM bank_accounts WHERE org_id IN (${ORG_A}, ${ORG_B})`);
  await app.close();
});

describe("Fund ↔ bank account FK (Epic #416 Task 3)", () => {
  it("PATCH /v1/funds/:id persists bankAccountId link", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/funds/${fundA}`,
      headers: authHeader(token),
      payload: { bankAccountId: bankAccountA },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: { bankAccountId: string | null; settlementCurrency: string | null };
    }>();
    expect(body.data.bankAccountId).toBe(bankAccountA);
    expect(body.data.settlementCurrency).toBe("CHF");
  });

  it("PATCH /v1/funds/:id with cross-org bankAccountId returns 404", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/funds/${fundA}`,
      headers: authHeader(token),
      payload: { bankAccountId: bankAccountB },
    });

    expect(res.statusCode).toBe(404);
    const body = res.json<{ detail: string }>();
    expect(body.detail).toMatch(/bank.?account/i);
  });

  it("PATCH /v1/funds/:id with inactive bankAccountId returns 422", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/funds/${fundA}`,
      headers: authHeader(token),
      payload: { bankAccountId: inactiveBankAccountA },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json<{ detail: string }>();
    expect(body.detail).toMatch(/inactive/i);
  });

  it("PATCH /v1/funds/:id with bankAccountId = null clears the FK", async () => {
    // First confirm it's currently linked
    const tokenA = signToken(app);
    const linked = await app.inject({
      method: "GET",
      url: `/v1/funds/${fundA}`,
      headers: authHeader(tokenA),
    });
    expect(linked.statusCode).toBe(200);

    // Unlink
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/funds/${fundA}`,
      headers: authHeader(tokenA),
      payload: { bankAccountId: null },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: { bankAccountId: string | null; settlementCurrency: string | null };
    }>();
    expect(body.data.bankAccountId).toBeNull();
    expect(body.data.settlementCurrency).toBeNull();
  });
});
