/**
 * Coverage for issue #56 follow-up hardening.
 *
 * One file per issue item keeps the diff surgical and makes it obvious which
 * tests belong to this round of work. Items covered:
 *   • QA #1  — donation body `constituentId` invalid-UUID 400
 *   • QA #7  — pagination boundary tests (over-max, page beyond last)
 *   • QA #10 — outbox idempotency replay test
 *   • QA #16 — donations + receipts survive GDPR erasure
 *   • Data #1/#2 — cross-tenant FK checks on campaignId + fundId return 404
 *   • API #2 — Idempotency-Key dedup replays cached response
 *   • API #6 — Merge ETag / If-Match 409 on concurrent edit
 *   • API minor — GET /v1/donations/:id/receipt returns `expiresAt`
 *
 * These tests hit the HTTP layer (via Fastify inject) so we exercise the
 * route → service → DB path end-to-end.
 */

import {
  auditLogs,
  constituents,
  donations,
  funds,
  outboxEvents,
  receipts,
} from "@givernance/shared/schema";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, withTenantContext } from "../../lib/db.js";
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

// A dedicated org + users for this suite so setup doesn't collide with the
// tenant/fund cleanup other tests do.
const HARDENING_ORG = "00000000-0000-0000-0000-0000000056aa";

let orgAConstituentId: string;
let orgBFundId: string;
let orgBCampaignId: string;

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();

  await db.execute(
    sql`INSERT INTO tenants (id, name, slug, base_currency)
        VALUES (${HARDENING_ORG}, 'Issue 56 Hardening Org', 'issue-56-hardening', 'EUR')
        ON CONFLICT (id) DO NOTHING`,
  );

  const tokenA = signToken(app);
  const tokenB = signTokenB(app);

  const constituentRes = await app.inject({
    method: "POST",
    url: "/v1/constituents?force=true",
    headers: authHeader(tokenA),
    payload: { firstName: "Hardening", lastName: "Donor", type: "donor" },
  });
  orgAConstituentId = constituentRes.json<{ data: { id: string } }>().data.id;

  // Tenant B fund + campaign — needed for the cross-tenant 404 tests below.
  await withTenantContext(ORG_B, async (tx) => {
    const [fund] = await tx
      .insert(funds)
      .values({ orgId: ORG_B, name: "Hardening Fund B", type: "unrestricted" })
      .onConflictDoUpdate({
        target: [funds.orgId, funds.name],
        set: { updatedAt: new Date() },
      })
      .returning();
    // biome-ignore lint/style/noNonNullAssertion: onConflictDoUpdate always returns
    orgBFundId = fund!.id;
  });

  const orgBCampaignRes = await app.inject({
    method: "POST",
    url: "/v1/campaigns",
    headers: authHeader(tokenB),
    payload: { name: "Tenant B hardening", type: "digital" },
  });
  orgBCampaignId = orgBCampaignRes.json<{ data: { id: string } }>().data.id;
});

afterAll(async () => {
  await app.close();
});

// ─── Donation body validation (QA #1) ───────────────────────────────────────

describe("Donations — invalid-UUID body rejection (QA #1)", () => {
  it("rejects a non-UUID constituentId with 400 before hitting the service", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/donations",
      headers: authHeader(signToken(app)),
      payload: {
        constituentId: "not-a-uuid",
        amountCents: 1000,
        currency: "EUR",
        donatedAt: "2026-01-15T00:00:00.000Z",
      },
    });

    expect(res.statusCode).toBe(400);
  });
});

// ─── Cross-tenant FK checks (Data #1 / #2) ──────────────────────────────────

describe("Donations — cross-tenant FK checks return 404 (Data #1/#2)", () => {
  it("returns 404 when campaignId belongs to another tenant", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/donations",
      headers: authHeader(signToken(app)),
      payload: {
        constituentId: orgAConstituentId,
        amountCents: 1000,
        currency: "EUR",
        campaignId: orgBCampaignId, // ← Tenant B
        donatedAt: "2026-01-15T00:00:00.000Z",
      },
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 404 when allocation fundId belongs to another tenant", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/donations",
      headers: authHeader(signToken(app)),
      payload: {
        constituentId: orgAConstituentId,
        amountCents: 1000,
        currency: "EUR",
        donatedAt: "2026-01-15T00:00:00.000Z",
        allocations: [{ fundId: orgBFundId, amountCents: 1000 }],
      },
    });

    expect(res.statusCode).toBe(404);
  });
});

// ─── Pagination boundaries (QA #7) ──────────────────────────────────────────

describe("Pagination boundaries (QA #7)", () => {
  it("rejects perPage > max with 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents?perPage=10000",
      headers: authHeader(signToken(app)),
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects page=0 with 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents?page=0",
      headers: authHeader(signToken(app)),
    });
    expect(res.statusCode).toBe(400);
  });

  it("page far beyond last returns empty data with correct pagination metadata", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents?page=9999&perPage=20",
      headers: authHeader(signToken(app)),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: unknown[];
      pagination: { page: number; perPage: number; total: number; totalPages: number };
    }>();
    expect(body.data).toEqual([]);
    expect(body.pagination.page).toBe(9999);
    expect(body.pagination.perPage).toBe(20);
  });
});

// ─── Idempotency-Key dedup (API #2) ─────────────────────────────────────────

describe("Idempotency-Key (API #2)", () => {
  it("replays the cached response for the same org + key", async () => {
    const idempotencyKey = `donation-${Date.now()}-${Math.random()}`;
    const payload = {
      constituentId: orgAConstituentId,
      amountCents: 4242,
      currency: "EUR",
      donatedAt: "2026-03-01T00:00:00.000Z",
    };

    const first = await app.inject({
      method: "POST",
      url: "/v1/donations",
      headers: {
        ...authHeader(signToken(app)),
        "idempotency-key": idempotencyKey,
      },
      payload,
    });
    expect(first.statusCode).toBe(201);
    const firstDonationId = first.json<{ data: { id: string } }>().data.id;

    const replay = await app.inject({
      method: "POST",
      url: "/v1/donations",
      headers: {
        ...authHeader(signToken(app)),
        "idempotency-key": idempotencyKey,
      },
      payload,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(replay.json<{ data: { id: string } }>().data.id).toBe(firstDonationId);
  });

  it("different keys produce independent donations", async () => {
    const payload = {
      constituentId: orgAConstituentId,
      amountCents: 4243,
      currency: "EUR",
      donatedAt: "2026-03-02T00:00:00.000Z",
    };

    const a = await app.inject({
      method: "POST",
      url: "/v1/donations",
      headers: {
        ...authHeader(signToken(app)),
        "idempotency-key": `k1-${Date.now()}-${Math.random()}`,
      },
      payload: { ...payload, paymentRef: `k1-${Date.now()}-${Math.random()}` },
    });
    const b = await app.inject({
      method: "POST",
      url: "/v1/donations",
      headers: {
        ...authHeader(signToken(app)),
        "idempotency-key": `k2-${Date.now()}-${Math.random()}`,
      },
      payload: { ...payload, paymentRef: `k2-${Date.now()}-${Math.random()}` },
    });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.json<{ data: { id: string } }>().data.id).not.toBe(
      b.json<{ data: { id: string } }>().data.id,
    );
  });
});

// ─── Merge ETag / If-Match 409 (API #6) ─────────────────────────────────────

describe("Merge If-Match / ETag (API #6)", () => {
  it("rejects a merge with a stale If-Match header", async () => {
    const tokenA = signToken(app);

    // Create two mergeable constituents.
    const p = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(tokenA),
      payload: { firstName: "Etag", lastName: "Primary", type: "donor" },
    });
    const primaryId = p.json<{ data: { id: string } }>().data.id;

    const d = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(tokenA),
      payload: { firstName: "Etag", lastName: "Duplicate", type: "donor" },
    });
    const duplicateId = d.json<{ data: { id: string } }>().data.id;

    // Bump the survivor so our fabricated ETag is stale relative to reality.
    await withTenantContext(ORG_A, async (tx) => {
      await tx
        .update(constituents)
        .set({ phone: "+33111111111", updatedAt: new Date() })
        .where(and(eq(constituents.id, primaryId), eq(constituents.orgId, ORG_A)));
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/constituents/${primaryId}/merge`,
      headers: {
        ...authHeader(tokenA),
        "if-match": `W/"${primaryId}-1"`, // Clearly stale timestamp.
      },
      payload: { targetId: duplicateId },
    });

    expect(res.statusCode).toBe(409);
  });

  it("returns an ETag on a successful merge", async () => {
    const tokenA = signToken(app);

    const p = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(tokenA),
      payload: { firstName: "EtagSuccess", lastName: "Primary", type: "donor" },
    });
    const primaryId = p.json<{ data: { id: string } }>().data.id;

    const d = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(tokenA),
      payload: { firstName: "EtagSuccess", lastName: "Duplicate", type: "donor" },
    });
    const duplicateId = d.json<{ data: { id: string } }>().data.id;

    const res = await app.inject({
      method: "POST",
      url: `/v1/constituents/${primaryId}/merge`,
      headers: authHeader(tokenA),
      payload: { targetId: duplicateId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toMatch(/^W\/".+"$/);
    expect(res.json<{ data: { etag: string } }>().data.etag).toMatch(/^W\/".+"$/);
  });
});

// ─── Outbox idempotency replay (QA #10) ─────────────────────────────────────

describe("Outbox replay idempotency (QA #10)", () => {
  it("re-marking a processed outbox event as pending does not produce a duplicate side-effect", async () => {
    // We don't have the relay available in-process here; instead we simulate
    // the "event already delivered" condition: write a synthetic outbox event,
    // then re-insert a row with the same `id` to assert we cannot double-insert
    // on replay. The relay's real deduplication is `jobId: row.id` which
    // BullMQ enforces — here we cover the DB-level invariant.
    const eventId = "00000000-0000-0000-0000-0000000056e1";
    await db.delete(outboxEvents).where(eq(outboxEvents.id, eventId));

    await db.insert(outboxEvents).values({
      id: eventId,
      tenantId: ORG_A,
      type: "hardening.test",
      payload: { marker: "first" },
      status: "completed",
    });

    // Second insert with the same PK must fail — this is the guard the relay
    // relies on to prevent a replayed event from being re-written to the DB.
    await expect(
      db.insert(outboxEvents).values({
        id: eventId,
        tenantId: ORG_A,
        type: "hardening.test",
        payload: { marker: "second" },
      }),
    ).rejects.toBeDefined();

    // Clean up.
    await db.delete(outboxEvents).where(eq(outboxEvents.id, eventId));
  });
});

// ─── Donations + receipts survive GDPR erasure (QA #16) ─────────────────────

describe("GDPR erasure leaves donations + receipts intact (QA #16)", () => {
  it("a constituent soft-delete keeps donations and generated receipts queryable", async () => {
    const tokenA = signToken(app);

    const c = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(tokenA),
      payload: { firstName: "Erasable", lastName: "Donor", type: "donor" },
    });
    const constituentId = c.json<{ data: { id: string } }>().data.id;

    // Create a donation + receipt directly. Going through the worker to
    // generate a real PDF is out of scope for this API-level assertion.
    let donationId: string;
    await withTenantContext(ORG_A, async (tx) => {
      const [don] = await tx
        .insert(donations)
        .values({
          orgId: ORG_A,
          constituentId,
          amountCents: 5000,
          currency: "EUR",
          amountBaseCents: 5000,
          exchangeRate: "1.00000000",
          donatedAt: new Date("2026-02-01T00:00:00.000Z"),
          fiscalYear: 2026,
        })
        .returning();
      // biome-ignore lint/style/noNonNullAssertion: returning always returns
      donationId = don!.id;
      await tx.insert(receipts).values({
        orgId: ORG_A,
        donationId,
        receiptNumber: `REC-2026-${Math.floor(Math.random() * 1_000_000)}`,
        fiscalYear: 2026,
        s3Path: `${ORG_A}/receipts/test.pdf`,
        status: "generated",
      });
    });

    // Issue the soft-delete on the constituent — what the GDPR erasure flow
    // does at the API level.
    const del = await app.inject({
      method: "DELETE",
      url: `/v1/constituents/${constituentId}`,
      headers: authHeader(tokenA),
    });
    expect(del.statusCode).toBe(200);

    // Donations and receipts must remain — regulators allow (and require)
    // retention of tax-deductible donations past an erasure request.
    await withTenantContext(ORG_A, async (tx) => {
      const donationRows = await tx
        .select({ id: donations.id })
        .from(donations)
        // biome-ignore lint/style/noNonNullAssertion: donationId is assigned above
        .where(eq(donations.id, donationId!));
      expect(donationRows.length).toBe(1);

      const receiptRows = await tx
        .select({ id: receipts.id })
        .from(receipts)
        // biome-ignore lint/style/noNonNullAssertion: donationId is assigned above
        .where(eq(receipts.donationId, donationId!));
      expect(receiptRows.length).toBe(1);
    });
  });
});

// ─── Audit double-attribution E2E (Security #16 / ADR impersonation) ───────

describe("Audit actorId double-attribution E2E", () => {
  /**
   * Wait up to 2s for the async `onResponse` audit hook to commit the row
   * for the specific action+subject we just generated. The hook runs AFTER
   * the response is sent to the client, so `app.inject` returns before the
   * insert commits. Polling is more robust than a fixed sleep.
   */
  async function awaitAuditRow(params: {
    action: string;
    userId: string;
  }): Promise<{ userId: string | null; actorId: string | null } | undefined> {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const [row] = await db
        .select({ userId: auditLogs.userId, actorId: auditLogs.actorId })
        .from(auditLogs)
        .where(and(eq(auditLogs.action, params.action), eq(auditLogs.userId, params.userId)))
        .orderBy(sql`${auditLogs.createdAt} DESC`)
        .limit(1);
      if (row) return row;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return undefined;
  }

  it("records act.sub in audit_logs.actor_id when the JWT carries an `act` claim", async () => {
    const adminSub = "00000000-0000-0000-0000-0000000000ad";
    // Use a dedicated subject so we can find our row unambiguously even if
    // parallel tests are hammering the audit_logs table.
    const impersonatedUserSub = "00000000-0000-0000-0000-0000000000bd";
    // Mint a token where the effective subject (`sub`) and the impersonating
    // actor (`act.sub`) differ — this is what the impersonation flow produces.
    const impersonationToken = signToken(app, {
      sub: impersonatedUserSub,
      act: { sub: adminSub },
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(impersonationToken),
      payload: { firstName: "Audit", lastName: "DoubleAttr", type: "donor" },
    });
    expect(res.statusCode).toBe(201);

    const row = await awaitAuditRow({
      action: "POST:/v1/constituents",
      userId: impersonatedUserSub,
    });

    expect(row).toBeDefined();
    expect(row?.actorId).toBe(adminSub);
    expect(row?.userId).toBe(impersonatedUserSub);
  });

  it("leaves actor_id NULL under normal (non-impersonated) auth", async () => {
    // Fresh subject so we don't race with the impersonated test above.
    const plainSub = "00000000-0000-0000-0000-0000000000cd";
    const tokenA = signToken(app, { sub: plainSub });

    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(tokenA),
      payload: { firstName: "Audit", lastName: "NoActor", type: "donor" },
    });
    expect(res.statusCode).toBe(201);

    const row = await awaitAuditRow({ action: "POST:/v1/constituents", userId: plainSub });

    expect(row).toBeDefined();
    expect(row?.actorId).toBeNull();
  });
});

// ─── Receipt URL includes expiresAt (API minor) ─────────────────────────────

describe("GET /v1/donations/:id/receipt exposes expiresAt (API minor)", () => {
  it("returns both url and ISO-8601 expiresAt in the data envelope", async () => {
    const tokenA = signToken(app);

    let donationId: string;
    await withTenantContext(ORG_A, async (tx) => {
      const [don] = await tx
        .insert(donations)
        .values({
          orgId: ORG_A,
          constituentId: orgAConstituentId,
          amountCents: 1000,
          currency: "EUR",
          amountBaseCents: 1000,
          exchangeRate: "1.00000000",
          donatedAt: new Date("2026-04-01T00:00:00.000Z"),
          fiscalYear: 2026,
        })
        .returning();
      // biome-ignore lint/style/noNonNullAssertion: returning always returns
      donationId = don!.id;
      await tx.insert(receipts).values({
        orgId: ORG_A,
        donationId,
        receiptNumber: `REC-2026-${Math.floor(Math.random() * 1_000_000)}`,
        fiscalYear: 2026,
        s3Path: `${ORG_A}/receipts/expires.pdf`,
        status: "generated",
      });
    });

    const res = await app.inject({
      method: "GET",
      // biome-ignore lint/style/noNonNullAssertion: donationId is assigned above
      url: `/v1/donations/${donationId!}/receipt`,
      headers: authHeader(tokenA),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { url: string; expiresAt: string } }>();
    expect(typeof body.data.url).toBe("string");
    expect(body.data.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Must be in the future.
    expect(new Date(body.data.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });
});
