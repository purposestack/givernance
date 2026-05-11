/**
 * Bank Accounts CRUD integration tests (Epic #318, PR #2).
 *
 * Covers tenant isolation (RLS), IBAN normalisation + classification,
 * soft-delete cascade to campaigns, EUR + QR-IBAN rejection, BIC length
 * validation, and the audit-plugin coverage (resource_type + resource_id
 * extracted from the /v1/bank-accounts/:id URL).
 */

import { bankAccounts, campaigns } from "@givernance/shared/schema";
import { and, eq, sql } from "drizzle-orm";
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
  // Fresh slate — partial unique on (org_id, iban) WHERE deleted_at IS
  // NULL would collide on every re-run otherwise. Hard-delete here is
  // safe because no swiss_qr_references rows exist yet (PR #3 lands
  // the worker integration that issues them).
  await db.execute(sql`DELETE FROM bank_accounts WHERE org_id IN (${ORG_A}, ${ORG_B})`);
});

afterAll(async () => {
  await app.close();
});

// ─── Canonical test IBANs ──────────────────────────────────────────────────
// `CH9300762011623852957` — canonical PostFinance test IBAN (regular).
// `CH4431999123000889012` — SIX-reserved test QR-IBAN (IID 31999).
// `LI21088100002324013AA` — canonical valid LI IBAN.
// `FR1420041010050500013M02606` — real valid French IBAN (non-CH/LI).
const VALID_CH_IBAN = "CH9300762011623852957";
const VALID_QR_IBAN = "CH4431999123000889012";
const VALID_LI_IBAN = "LI21088100002324013AA";
const VALID_FR_IBAN = "FR1420041010050500013M02606";

const BASE_HOLDER = {
  holderName: "Association Givernance Test",
  holderStreet: "Rue de la Paix",
  holderBuildingNumber: "12",
  holderPostalCode: "1003",
  holderTown: "Lausanne",
  holderCountryCode: "CH",
};

describe("Bank Accounts CRUD", () => {
  let regularAccountId: string;
  let qrIbanAccountId: string;

  it("POST /v1/bank-accounts creates a regular-IBAN account", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/bank-accounts",
      headers: authHeader(token),
      payload: {
        ...BASE_HOLDER,
        // Mixed-case + whitespace ingress to verify canonicalisation.
        iban: "ch93 0076 2011 6238 5295 7",
        bankName: "PostFinance",
        currency: "CHF",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{
      data: { id: string; iban: string; ibanKind: string; currency: string };
    }>();
    expect(body.data.iban).toBe(VALID_CH_IBAN); // canonicalised
    expect(body.data.ibanKind).toBe("iban");
    expect(body.data.currency).toBe("CHF");
    regularAccountId = body.data.id;
  });

  it("POST /v1/bank-accounts derives `qr_iban` from the IID range (30000-31999)", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/bank-accounts",
      headers: authHeader(token),
      payload: {
        ...BASE_HOLDER,
        iban: VALID_QR_IBAN,
        bankName: "UBS Switzerland AG",
        currency: "CHF",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ data: { id: string; ibanKind: string } }>();
    expect(body.data.ibanKind).toBe("qr_iban");
    qrIbanAccountId = body.data.id;
  });

  it("POST /v1/bank-accounts rejects a non-CH/LI IBAN", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/bank-accounts",
      headers: authHeader(token),
      payload: {
        ...BASE_HOLDER,
        iban: VALID_FR_IBAN,
        bankName: "BNP Paribas",
        currency: "EUR",
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ detail: string }>();
    expect(body.detail).toMatch(/CH and LI/);
  });

  it("POST /v1/bank-accounts accepts a Liechtenstein IBAN", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/bank-accounts",
      headers: authHeader(token),
      payload: {
        ...BASE_HOLDER,
        holderCountryCode: "LI",
        iban: VALID_LI_IBAN,
        bankName: "LLB",
        currency: "CHF",
      },
    });

    expect(res.statusCode).toBe(201);
  });

  it("PATCH /v1/bank-accounts/:id rejects a BIC of invalid length (ISO 9362 = 8 or 11)", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/bank-accounts/${regularAccountId}`,
      headers: authHeader(token),
      payload: { bic: "ABCDEFG" }, // 7 chars — invalid
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ detail: string }>();
    expect(body.detail).toMatch(/BIC/);
  });

  it("POST /v1/bank-accounts rejects a malformed (mod-97-fail) IBAN", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/bank-accounts",
      headers: authHeader(token),
      payload: {
        ...BASE_HOLDER,
        iban: "CH9300762011623852958", // last digit flipped — checksum fails
        bankName: "PostFinance",
        currency: "CHF",
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it("GET /v1/bank-accounts lists tenant accounts excluding soft-deleted", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/bank-accounts",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: Array<{ id: string; deletedAt: string | null }>;
      pagination: { total: number };
    }>();
    expect(body.pagination.total).toBeGreaterThanOrEqual(2);
    expect(body.data.every((a) => a.deletedAt === null)).toBe(true);
  });

  it("GET /v1/bank-accounts/:id returns one account", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/bank-accounts/${regularAccountId}`,
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { id: string; iban: string } }>();
    expect(body.data.id).toBe(regularAccountId);
    expect(body.data.iban).toBe(VALID_CH_IBAN);
  });

  it("PATCH /v1/bank-accounts/:id updates mutable fields", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/bank-accounts/${regularAccountId}`,
      headers: authHeader(token),
      payload: {
        holderName: "Association Givernance Test — Renamed",
        bic: "POFICHBE", // canonical PostFinance BIC, 8 chars
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { holderName: string; bic: string | null } }>();
    expect(body.data.holderName).toContain("Renamed");
    expect(body.data.bic).toBe("POFICHBE");
  });

  it("PATCH /v1/bank-accounts/:id rejects EUR on a QR-IBAN account", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/bank-accounts/${qrIbanAccountId}`,
      headers: authHeader(token),
      payload: { currency: "EUR" },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ detail: string }>();
    expect(body.detail).toMatch(/EUR/);
  });

  it("POST duplicate active IBAN within the same org returns 409", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/bank-accounts",
      headers: authHeader(token),
      payload: {
        ...BASE_HOLDER,
        iban: VALID_CH_IBAN, // already taken by regularAccountId
        bankName: "PostFinance",
        currency: "CHF",
      },
    });

    expect(res.statusCode).toBe(409);
  });

  it("Tenant isolation: ORG_B cannot read ORG_A's account", async () => {
    const tokenB = signTokenB(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/bank-accounts/${regularAccountId}`,
      headers: authHeader(tokenB),
    });
    expect(res.statusCode).toBe(404);
  });

  it("Tenant isolation: ORG_B cannot patch ORG_A's account", async () => {
    const tokenB = signTokenB(app);
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/bank-accounts/${regularAccountId}`,
      headers: authHeader(tokenB),
      payload: { holderName: "Hijacked" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("Tenant isolation: ORG_B's list omits ORG_A's accounts entirely", async () => {
    const tokenB = signTokenB(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/bank-accounts",
      headers: authHeader(tokenB),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ id: string }> }>();
    expect(body.data.every((a) => a.id !== regularAccountId)).toBe(true);
    expect(body.data.every((a) => a.id !== qrIbanAccountId)).toBe(true);
  });

  it("GET /v1/bank-accounts/:id/usage returns 0/0 before any swiss_qr_references rows exist", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/bank-accounts/${regularAccountId}/usage`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: { swissQrReferenceCount: number; linkedCampaignCount: number };
    }>();
    expect(body.data.swissQrReferenceCount).toBe(0);
    expect(body.data.linkedCampaignCount).toBe(0);
  });

  it("DELETE /v1/bank-accounts/:id soft-deletes + unlinks campaigns", async () => {
    // Pre-create the link so we can verify the FK cascade clears it.
    // Postgres doesn't support LIMIT directly on UPDATE — go via a
    // subselect.
    await db.execute(
      sql`UPDATE campaigns SET bank_account_id = ${regularAccountId}
          WHERE id IN (SELECT id FROM campaigns WHERE org_id = ${ORG_A} LIMIT 1)`,
    );
    const token = signToken(app);
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/bank-accounts/${regularAccountId}`,
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { id: string; deletedAt: string | null } }>();
    expect(body.data.id).toBe(regularAccountId);
    expect(body.data.deletedAt).not.toBeNull();

    // Verify the soft-deleted row no longer surfaces in default list.
    const listRes = await app.inject({
      method: "GET",
      url: "/v1/bank-accounts",
      headers: authHeader(token),
    });
    const list = listRes.json<{ data: Array<{ id: string }> }>();
    expect(list.data.find((a) => a.id === regularAccountId)).toBeUndefined();

    // Verify no campaign in ORG_A still points at the soft-deleted account.
    const stillLinked = await db
      .select({ count: sql<number>`count(*)` })
      .from(campaigns)
      .where(and(eq(campaigns.orgId, ORG_A), eq(campaigns.bankAccountId, regularAccountId)));
    expect(Number(stillLinked[0]?.count ?? 0)).toBe(0);
  });

  it("Re-create the same IBAN after soft-delete succeeds (partial unique WHERE deleted_at IS NULL)", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/bank-accounts",
      headers: authHeader(token),
      payload: {
        ...BASE_HOLDER,
        iban: VALID_CH_IBAN, // freed by the soft-delete above
        bankName: "PostFinance — Re-registered",
        currency: "CHF",
      },
    });

    expect(res.statusCode).toBe(201);
  });

  it("includeDeleted=true surfaces soft-deleted rows in the list", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/bank-accounts?includeDeleted=true",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: Array<{ id: string; deletedAt: string | null }>;
    }>();
    expect(body.data.some((a) => a.id === regularAccountId && a.deletedAt !== null)).toBe(true);
  });

  it("DELETE on already-deleted account returns 404", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/bank-accounts/${regularAccountId}`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("Bank Accounts — IBAN canonical CHECK", () => {
  it("the DB rejects an IBAN with whitespace if the service is bypassed (last-line-of-defence)", async () => {
    // Direct DB path — owner role bypasses RLS but the CHECK constraint
    // catches anything that escapes service-level canonicalisation.
    await expect(
      db
        .insert(bankAccounts)
        .values({
          orgId: ORG_A,
          holderName: "Test",
          holderStreet: "Street",
          holderPostalCode: "1003",
          holderTown: "Lausanne",
          holderCountryCode: "CH",
          iban: "ch 9300 0762 0116 2385 2957", // lowercase + spaces
          ibanKind: "iban",
          bankName: "Test",
          currency: "CHF",
        })
        .returning(),
    ).rejects.toThrow();
  });
});
