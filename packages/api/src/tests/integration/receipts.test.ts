import { Readable } from "node:stream";
import { receipts } from "@givernance/shared/schema";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenantContext } from "../../lib/db.js";
import { createServer } from "../../server.js";
import { authHeader, ensureTestTenants, ORG_A, signToken, signTokenB } from "../helpers/auth.js";

// Stub S3 fetch so the streaming download tests don't depend on a real
// MinIO object existing at the receipt's s3_path. The 403/404 paths
// short-circuit before reaching this, so they exercise pure auth +
// tenant-scope logic regardless of the stub. `vi.hoisted` is the only
// way to reference a mock factory's fn from the rest of the file (the
// `vi.mock` call is hoisted above all imports), and it lets us call
// `mockClear` / `mockRejectedValueOnce` per test.
const STUB_PDF_BYTES = Buffer.from("%PDF-1.4 stub-receipt", "utf8");
const { mockedFetchReceipt } = vi.hoisted(() => ({
  mockedFetchReceipt: vi.fn(),
}));
vi.mock("../../lib/s3.js", () => ({
  fetchReceiptObject: mockedFetchReceipt,
}));

let app: FastifyInstance;

let constituentIdA: string;
let donationIdA: string;
const receiptSuffix = Date.now().toString(36);
const receiptNumber = `REC-2026-${receiptSuffix}`;

beforeAll(async () => {
  // Default mock impl — emits a fresh `Readable` per call so each test
  // gets an unconsumed stream (Node `Readable.from` returns one-shot
  // streams that error on a second `pipe`).
  mockedFetchReceipt.mockImplementation(async () => ({
    body: Readable.from(STUB_PDF_BYTES),
    contentLength: STUB_PDF_BYTES.length,
  }));
  app = await createServer();
  await app.ready();
  await ensureTestTenants();

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

  it("GET /v1/donations/:id/receipt returns same-origin downloadPath after receipt is inserted", async () => {
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
    const body = res.json<{ data: { downloadPath: string; expiresAt: string } }>();
    // Lock the post-#214 contract: relative download path on the app's
    // own apex, never a presigned MinIO URL with a Docker-internal
    // hostname. The leading "/" matters — frontend opens this as a
    // same-origin URL so the donor never leaves staging.givernance.org.
    expect(body.data.downloadPath).toBe(`/v1/donations/${donationIdA}/receipt/download`);
    expect(body.data.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // expiresAt is a coarse "consider re-fetching after" hint — must be
    // in the future at response time. We DO NOT lock to JWT exp here
    // (that would surface a session-rotation timing primitive); the
    // contract is only "future-tense ISO-8601, minute-aligned, ~1h
    // out". A regression that started leaking the JWT exp would
    // surface as a per-test timestamp drift, which the upper bound
    // catches.
    const expiresAtMs = new Date(body.data.expiresAt).getTime();
    expect(expiresAtMs).toBeGreaterThan(Date.now());
    expect(expiresAtMs).toBeLessThanOrEqual(Date.now() + 90 * 60 * 1000); // sanity ceiling
    expect(expiresAtMs % 60_000).toBe(0); // minute-aligned, no second-precision leak
    // Defend against accidental regression to a presigned-URL response
    // shape (which would re-introduce the cross-domain hop).
    expect(body.data).not.toHaveProperty("url");
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

// ─── Receipt Download (streaming) endpoint — issue #214 ───────────────────

describe("Receipt download endpoint", () => {
  it("GET /v1/donations/:id/receipt/download streams the PDF with PDF headers", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/donations/${donationIdA}/receipt/download`,
      headers: authHeader(tokenA),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toBe(`attachment; filename="${receiptNumber}.pdf"`);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.headers["content-length"]).toBe(String(STUB_PDF_BYTES.length));
    expect(res.rawPayload.equals(STUB_PDF_BYTES)).toBe(true);
  });

  it("logs an audit entry with userId, donationId, and receiptNumber on every download", async () => {
    // The default test app pins LOG_LEVEL=silent and uses Pino's stdout
    // sonic-boom destination, so a `vi.spyOn(app.log, "info")` doesn't
    // see writes via the request-scoped child logger. Spin up a parallel
    // server with the `onLogLine` capture hook (same pattern as
    // rbac-denial-logs.test.ts) so we can assert on the actual emitted
    // JSON record — what Loki will index in production.
    const captured: Record<string, unknown>[] = [];
    const captureApp = await createServer({
      onLogLine: (line) => {
        for (const record of line.trim().split("\n")) {
          if (!record.trim()) continue;
          try {
            captured.push(JSON.parse(record) as Record<string, unknown>);
          } catch {
            // skip non-JSON
          }
        }
      },
    });
    await captureApp.ready();
    try {
      const tokenA = signToken(captureApp);
      const res = await captureApp.inject({
        method: "GET",
        url: `/v1/donations/${donationIdA}/receipt/download`,
        headers: authHeader(tokenA),
      });
      expect(res.statusCode).toBe(200);

      const auditLine = captured.find((rec) => rec.msg === "Receipt downloaded");
      expect(auditLine, "expected an audit log line for the download").toBeTruthy();
      // Lock the field shape — these are the keys Loki queries against
      // for "who downloaded what" audit, and a rename here silently
      // breaks every saved query (docs/17-log-management.md).
      expect(auditLine).toMatchObject({
        orgId: ORG_A,
        donationId: donationIdA,
        receiptNumber,
        fiscalYear: 2026,
      });
      expect(auditLine).toHaveProperty("userId");
      expect(auditLine).toHaveProperty("receiptId");
    } finally {
      await captureApp.close();
    }
  });

  it("returns 404 when Tenant B requests Tenant A's receipt download AND never reaches S3", async () => {
    // Even with a valid receipt s3Path guess, a Tenant B token must not
    // reach `fetchReceiptObject` — auth + tenant-scope short-circuit at
    // the donation lookup. The 404 is intentional: 403 would leak the
    // existence of the donation across tenants. Asserting the mock was
    // *not* called is what catches a future refactor that reorders the
    // S3 hit before the tenant gate.
    mockedFetchReceipt.mockClear();
    const tokenB = signTokenB(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/donations/${donationIdA}/receipt/download`,
      headers: authHeader(tokenB),
    });

    expect(res.statusCode).toBe(404);
    expect(mockedFetchReceipt).not.toHaveBeenCalled();
    // Lock the RFC 9457 problem-detail body so a future regression to
    // a plain string or `{error: "..."}` shape is caught immediately
    // (memory: feedback_lock_rfc9457_body_in_tests).
    expect(res.json()).toMatchObject({
      type: expect.any(String),
      title: "Not Found",
      status: 404,
      detail: expect.any(String),
    });
  });

  it("GET /v1/donations/:id/receipt/download without token returns 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/donations/${donationIdA}/receipt/download`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("GET /v1/donations/:id/receipt/download returns 404 for non-existent donation", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/donations/00000000-0000-0000-0000-ffffffffffff/receipt/download",
      headers: authHeader(tokenA),
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 when the donation exists but its receipt is still pending (not yet generated)", async () => {
    // Lock the `getReceiptByDonation` filter on `status='generated'`:
    // a `pending` receipt row must NOT be downloadable (the worker
    // hasn't written the PDF to S3 yet, so streaming would 502 with a
    // NoSuchKey from MinIO). We surface 404 — the receipt isn't
    // available yet, same as the no-row case.
    const tokenA = signToken(app);

    // Insert a fresh donation + a pending receipt for it.
    const donRes = await app.inject({
      method: "POST",
      url: "/v1/donations",
      headers: authHeader(tokenA),
      payload: {
        constituentId: constituentIdA,
        amountCents: 4242,
        currency: "EUR",
        paymentMethod: "wire",
        fiscalYear: 2026,
      },
    });
    const pendingDonationId = donRes.json<{ data: { id: string } }>().data.id;
    const pendingReceiptNumber = `REC-2026-PENDING-${Date.now().toString(36)}`;
    await withTenantContext(ORG_A, async (tx) => {
      await tx.insert(receipts).values({
        orgId: ORG_A,
        donationId: pendingDonationId,
        receiptNumber: pendingReceiptNumber,
        fiscalYear: 2026,
        s3Path: `${ORG_A}/receipts/${pendingReceiptNumber}.pdf`,
        status: "pending",
      });
    });

    mockedFetchReceipt.mockClear();
    const res = await app.inject({
      method: "GET",
      url: `/v1/donations/${pendingDonationId}/receipt/download`,
      headers: authHeader(tokenA),
    });

    expect(res.statusCode).toBe(404);
    // S3 fetch must NOT happen for a pending receipt — proves the
    // 'generated' filter on `getReceiptByDonation` is load-bearing for
    // the download endpoint, not just the metadata endpoint.
    expect(mockedFetchReceipt).not.toHaveBeenCalled();
  });

  it("returns 502 + RFC 9457 body when MinIO fetch fails (NoSuchKey / network)", async () => {
    // Worker volume reset, manual S3 delete, MinIO container restart
    // mid-fetch — the row exists but the object is gone. We must not
    // leak the AWS SDK error class name (e.g. "NoSuchKey") or the s3Path
    // into the donor-facing problem-detail title.
    const tokenA = signToken(app);
    mockedFetchReceipt.mockRejectedValueOnce(
      Object.assign(new Error("The specified key does not exist."), {
        name: "NoSuchKey",
      }),
    );
    const res = await app.inject({
      method: "GET",
      url: `/v1/donations/${donationIdA}/receipt/download`,
      headers: authHeader(tokenA),
    });

    expect(res.statusCode).toBe(502);
    const body = res.json<{ title: string; detail: string; status: number; type: string }>();
    expect(body).toMatchObject({
      type: expect.any(String),
      title: "Bad Gateway",
      status: 502,
      detail: expect.any(String),
    });
    // Generic message — must not leak SDK error class or bucket key.
    expect(body.detail).not.toContain("NoSuchKey");
    expect(body.detail).not.toContain(".pdf");
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
