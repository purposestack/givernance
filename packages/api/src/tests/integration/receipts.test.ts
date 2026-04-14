import { receipts } from "@givernance/shared/schema";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, withTenantContext } from "../../lib/db.js";
import { createServer } from "../../server.js";
import { authHeader, ensureTestTenants, ORG_A, signToken, signTokenB } from "../helpers/auth.js";

let app: FastifyInstance;

let constituentIdA: string;
let donationIdA: string;
const receiptSuffix = Date.now().toString(36);
const receiptNumber = `REC-2026-${receiptSuffix}`;

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();

  // Clean up stale receipt data from prior runs
  await db.execute(sql`DELETE FROM receipts WHERE org_id = ${ORG_A}`);

  // Create a constituent
  const tokenA = signToken(app);
  const res1 = await app.inject({
    method: "POST",
    url: "/v1/constituents?force=true",
    headers: authHeader(tokenA),
    payload: {
      firstName: "Receipt",
      lastName: "Donor",
      email: "receipt-donor@example.org",
      type: "donor",
    },
  });
  constituentIdA = res1.json<{ data: { id: string } }>().data.id;

  // Create a donation
  const res2 = await app.inject({
    method: "POST",
    url: "/v1/donations",
    headers: authHeader(tokenA),
    payload: {
      constituentId: constituentIdA,
      amountCents: 15000,
      currency: "EUR",
      paymentMethod: "wire",
      fiscalYear: 2026,
    },
  });
  donationIdA = res2.json<{ data: { id: string } }>().data.id;
});

afterAll(async () => {
  await app.close();
});

// ─── Receipt Endpoint ──────────────────────────────────────────────────────

describe("Receipt endpoint", () => {
  it("GET /v1/donations/:id/receipt returns 404 when no receipt exists yet", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/donations/${donationIdA}/receipt`,
      headers: authHeader(tokenA),
    });

    expect(res.statusCode).toBe(404);
  });

  it("GET /v1/donations/:id/receipt returns presigned URL after receipt is inserted", async () => {
    // Simulate the worker inserting a receipt record (use withTenantContext, not session-scoped set_config)
    await withTenantContext(ORG_A, async (tx) => {
      await tx.insert(receipts).values({
        orgId: ORG_A,
        donationId: donationIdA,
        receiptNumber,
        fiscalYear: 2026,
        s3Path: `${ORG_A}/receipts/${receiptNumber}.pdf`,
        status: "generated",
      });
    });

    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/donations/${donationIdA}/receipt`,
      headers: authHeader(tokenA),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { url: string } }>();
    expect(body.data).toHaveProperty("url");
    expect(body.data.url).toContain(`${receiptNumber}.pdf`);
  });

  it("GET /v1/donations/:id/receipt returns 404 for non-existent donation", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/donations/00000000-0000-0000-0000-ffffffffffff/receipt",
      headers: authHeader(tokenA),
    });

    expect(res.statusCode).toBe(404);
  });

  it("GET /v1/donations/:id/receipt returns 400 for invalid UUID", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/donations/not-a-valid-uuid/receipt",
      headers: authHeader(tokenA),
    });

    expect(res.statusCode).toBe(400);
  });
});

// ─── Receipt RLS Tenant Isolation ──────────────────────────────────────────

describe("Receipt RLS tenant isolation", () => {
  it("Tenant B cannot access Tenant A receipt", async () => {
    const tokenB = signTokenB(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/donations/${donationIdA}/receipt`,
      headers: authHeader(tokenB),
    });

    expect(res.statusCode).toBe(404);
  });
});

// ─── Receipt Unauthenticated Access ────────────────────────────────────────

describe("Receipt unauthenticated access", () => {
  it("GET /v1/donations/:id/receipt without token returns 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/donations/${donationIdA}/receipt`,
    });
    expect(res.statusCode).toBe(401);
  });
});

// ─── Receipt DB record verification ────────────────────────────────────────

describe("Receipt DB record", () => {
  it("Receipt record has correct fields", async () => {
    await withTenantContext(ORG_A, async (tx) => {
      const [receipt] = await tx
        .select()
        .from(receipts)
        .where(and(eq(receipts.donationId, donationIdA), eq(receipts.orgId, ORG_A)));

      expect(receipt).toBeTruthy();
      expect(receipt?.receiptNumber).toBe(receiptNumber);
      expect(receipt?.fiscalYear).toBe(2026);
      expect(receipt?.status).toBe("generated");
      expect(receipt?.s3Path).toContain(`${receiptNumber}.pdf`);
    });
  });
});
