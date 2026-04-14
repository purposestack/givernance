import { receipts } from "@givernance/shared/schema";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";
import { createServer } from "../../server.js";

let app: FastifyInstance;

const ORG_A = "00000000-0000-0000-0000-000000000001";
const ORG_B = "00000000-0000-0000-0000-000000000002";
const USER_A = "00000000-0000-0000-0000-000000000099";
const USER_B = "00000000-0000-0000-0000-000000000098";

function signToken(app: FastifyInstance, claims: Record<string, unknown> = {}) {
  return app.jwt.sign({
    sub: USER_A,
    org_id: ORG_A,
    realm_access: { roles: ["admin"] },
    email: "user-a@example.org",
    role: "org_admin",
    ...claims,
  });
}

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

let constituentIdA: string;
let donationIdA: string;

beforeAll(async () => {
  app = await createServer();
  await app.ready();

  // Clean up stale receipt data from prior runs
  await db.execute(sql`DELETE FROM receipts WHERE org_id = ${ORG_A}`);

  // Ensure test tenants exist
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug) VALUES (${ORG_A}, 'Org A', 'test-org-a') ON CONFLICT (id) DO NOTHING`,
  );
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug) VALUES (${ORG_B}, 'Org B', 'test-org-b') ON CONFLICT (id) DO NOTHING`,
  );

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
    // Clean up any existing receipt and insert a fresh one in a single transaction
    // (ensures RLS set_config applies to both operations on the same connection)
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_org_id', ${ORG_A}, true)`);
      await tx
        .delete(receipts)
        .where(
          and(
            eq(receipts.orgId, ORG_A),
            eq(receipts.fiscalYear, 2026),
            eq(receipts.receiptNumber, "REC-2026-0001"),
          ),
        );
      await tx.insert(receipts).values({
        orgId: ORG_A,
        donationId: donationIdA,
        receiptNumber: "REC-2026-0001",
        fiscalYear: 2026,
        s3Path: `${ORG_A}/receipts/REC-2026-0001.pdf`,
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
    expect(body.data.url).toContain("REC-2026-0001.pdf");
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
});

// ─── Receipt RLS Tenant Isolation ──────────────────────────────────────────

describe("Receipt RLS tenant isolation", () => {
  it("Tenant B cannot access Tenant A receipt", async () => {
    const tokenB = signToken(app, { sub: USER_B, org_id: ORG_B, email: "user-b@example.org" });
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
    await db.execute(sql`SELECT set_config('app.current_org_id', ${ORG_A}, false)`);
    const [receipt] = await db
      .select()
      .from(receipts)
      .where(and(eq(receipts.donationId, donationIdA), eq(receipts.orgId, ORG_A)));

    expect(receipt).toBeTruthy();
    expect(receipt?.receiptNumber).toBe("REC-2026-0001");
    expect(receipt?.fiscalYear).toBe(2026);
    expect(receipt?.status).toBe("generated");
    expect(receipt?.s3Path).toContain("REC-2026-0001.pdf");
  });
});
