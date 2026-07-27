/**
 * Integration tests — download path for envelope-encrypted receipts
 * (issue #228). Modelled on `receipts.test.ts`: S3 fetch is stubbed
 * via `vi.hoisted`, fixtures are inserted through the owner-pool test
 * helpers, and the encrypted blobs are built with the REAL shared
 * crypto module so the route exercises genuine unwrap + GCM decrypt.
 *
 * The download route is NOT flag-gated (the flag only gates encryption
 * at generation), so no feature-flag manipulation is needed here — the
 * `receipts.encryption_scheme` column drives the branch.
 */

import { createCipheriv, randomBytes } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import {
  LocalKekProvider,
  RECEIPT_ENCRYPTION_SCHEME_V1,
  wrapDek,
} from "@givernance/shared/lib/receipt-crypto";
import { constituents, donations, receipts } from "@givernance/shared/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "../../server.js";
import { authHeader, ensureTestTenants, ORG_A, signToken } from "../helpers/auth.js";
import { db, withTenantContext } from "../helpers/db.js";

const STUB_PDF_BYTES = Buffer.from("%PDF-1.4 envelope-stub-receipt payload", "utf8");

const { mockedFetchReceipt } = vi.hoisted(() => ({
  mockedFetchReceipt: vi.fn(),
}));
vi.mock("../../lib/s3.js", () => ({
  fetchReceiptObject: mockedFetchReceipt,
}));

// Test keyring: v1 is the "old" version, v2 the rotated one.
const KEK_V1 = randomBytes(32).toString("base64");
const KEK_V2 = randomBytes(32).toString("base64");

/**
 * Envelope-encrypt the stub PDF exactly like the worker does — including
 * the AAD binding to the tenant orgId (D1). `aad` defaults to ORG_A,
 * the tenant every fixture row belongs to.
 */
function encryptStub(dek: Buffer, aad: Buffer = Buffer.from(ORG_A)) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dek, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(STUB_PDF_BYTES), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

let app: FastifyInstance;
let constituentIdA: string;
/** Donations created by this suite — deleted (with their receipts) in afterAll (T6). */
const createdDonationIds: string[] = [];

/** Per-test fixture: donation + encrypted receipt row + S3 stub wired to its ciphertext. */
async function createEncryptedReceiptFixture(options?: {
  kekVersionId?: string;
  wrapUnder?: string; // base64 KEK the dek_wrapped blob is actually sealed with
  corruptAuthTag?: boolean;
  /** AAD the ciphertext is bound to (default ORG_A) — for transplant tests. */
  aad?: Buffer;
  /** Set the plaintext_length COLUMN to NULL (legacy-writer simulation, T3). */
  nullPlaintextLength?: boolean;
}) {
  const tokenA = signToken(app);
  const donRes = await app.inject({
    method: "POST",
    url: "/v1/donations",
    headers: authHeader(tokenA),
    payload: {
      constituentId: constituentIdA,
      amountCents: 12000,
      currency: "EUR",
      paymentMethod: "wire",
      fiscalYear: 2026,
    },
  });
  const donationId = donRes.json<{ data: { id: string } }>().data.id;
  createdDonationIds.push(donationId);

  const dek = randomBytes(32);
  const { ciphertext, iv, authTag } = encryptStub(dek, options?.aad);
  const wrapped = wrapDek(dek, Buffer.from(options?.wrapUnder ?? KEK_V1, "base64"));
  const storedAuthTag = options?.corruptAuthTag
    ? Buffer.from(authTag.map((b) => b ^ 0xff)).toString("base64")
    : authTag.toString("base64");

  const receiptNumber = `REC-2026-ENV-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
  let receiptId = "";
  await withTenantContext(ORG_A, async (tx) => {
    const [row] = await tx
      .insert(receipts)
      .values({
        orgId: ORG_A,
        donationId,
        receiptNumber,
        fiscalYear: 2026,
        s3Path: `${ORG_A}/receipts/${receiptNumber}.pdf`,
        status: "generated",
        encryptionScheme: RECEIPT_ENCRYPTION_SCHEME_V1,
        dekWrapped: wrapped,
        kekVersionId: options?.kekVersionId ?? "v1",
        encryptionIv: iv.toString("base64"),
        encryptionAuthTag: storedAuthTag,
        plaintextLength: options?.nullPlaintextLength ? null : STUB_PDF_BYTES.length,
      })
      .returning({ id: receipts.id });
    receiptId = row!.id;
  });

  // Fresh one-shot Readable per call — the route fetches TWICE for an
  // encrypted receipt (integrity pre-verification pass + streaming pass).
  mockedFetchReceipt.mockImplementation(async () => ({
    body: Readable.from(ciphertext),
    contentLength: ciphertext.length,
  }));

  return { donationId, receiptId, receiptNumber, ciphertext, dek };
}

beforeAll(async () => {
  // The API KEK binding reads process.env at request time (see
  // lib/receipt-kek.ts), so setting it here — after module load — works.
  process.env.RECEIPT_ENCRYPTION_KEK_PROVIDER = "local";
  process.env.RECEIPT_ENCRYPTION_LOCAL_KEYRING = JSON.stringify({ v1: KEK_V1, v2: KEK_V2 });
  process.env.RECEIPT_ENCRYPTION_LOCAL_ACTIVE_VERSION = "v2";

  app = await createServer();
  await app.ready();
  await ensureTestTenants();

  const tokenA = signToken(app);
  const res = await app.inject({
    method: "POST",
    url: "/v1/constituents?force=true",
    headers: authHeader(tokenA),
    payload: {
      firstName: "Envelope",
      lastName: "Donor",
      email: "envelope-api-donor@example.org",
      type: "donor",
    },
  });
  constituentIdA = res.json<{ data: { id: string } }>().data.id;
});

afterAll(async () => {
  delete process.env.RECEIPT_ENCRYPTION_KEK_PROVIDER;
  delete process.env.RECEIPT_ENCRYPTION_LOCAL_KEYRING;
  delete process.env.RECEIPT_ENCRYPTION_LOCAL_ACTIVE_VERSION;
  // T6 — remove this suite's fixtures (worker-suite pattern): encrypted
  // receipt rows must not linger in the shared test DB where the
  // worker's platform-wide rewrap sweep tests would trip over them.
  if (createdDonationIds.length > 0) {
    await db
      .delete(receipts)
      .where(and(eq(receipts.orgId, ORG_A), inArray(receipts.donationId, createdDonationIds)));
    await db
      .delete(donations)
      .where(and(eq(donations.orgId, ORG_A), inArray(donations.id, createdDonationIds)));
  }
  await db
    .delete(constituents)
    .where(and(eq(constituents.orgId, ORG_A), eq(constituents.id, constituentIdA)));
  await app.close();
});

describe("Encrypted receipt download — happy path", () => {
  it("decrypts in-flight: 200, plaintext bytes, Content-Length = plaintext_length, PDF headers", async () => {
    const { donationId, receiptNumber } = await createEncryptedReceiptFixture();
    mockedFetchReceipt.mockClear();

    const res = await app.inject({
      method: "GET",
      url: `/v1/donations/${donationId}/receipt/download`,
      headers: authHeader(signToken(app)),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toBe(`inline; filename="${receiptNumber}.pdf"`);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    // Content-Length is the PLAINTEXT length, sourced from the byte
    // count the integrity verification pass measured (review L4 — exact
    // by construction; the DB column is advisory metadata only).
    expect(res.headers["content-length"]).toBe(String(STUB_PDF_BYTES.length));
    expect(res.rawPayload.equals(STUB_PDF_BYTES)).toBe(true);
    // Two S3 GETs by design: integrity pre-verification + streaming pass.
    expect(mockedFetchReceipt).toHaveBeenCalledTimes(2);
  });

  it("still serves rows wrapped under an OLD keyring version, and after a re-wrap to the active one", async () => {
    // Row wrapped under v1 while the active version is v2 — the
    // mid-rotation state. Unwrap must select by the row's kek_version_id.
    const { donationId, receiptId } = await createEncryptedReceiptFixture({
      kekVersionId: "v1",
      wrapUnder: KEK_V1,
    });

    const before = await app.inject({
      method: "GET",
      url: `/v1/donations/${donationId}/receipt/download`,
      headers: authHeader(signToken(app)),
    });
    expect(before.statusCode).toBe(200);
    expect(before.rawPayload.equals(STUB_PDF_BYTES)).toBe(true);

    // Re-wrap onto v2 — the same unwrap→wrap→UPDATE the worker's
    // `receipts.rewrap_deks` sweep performs (DB-only, S3 untouched).
    const provider = new LocalKekProvider({ v1: KEK_V1, v2: KEK_V2 }, "v2");
    const [row] = await db
      .select({ dekWrapped: receipts.dekWrapped, kekVersionId: receipts.kekVersionId })
      .from(receipts)
      .where(and(eq(receipts.id, receiptId), eq(receipts.orgId, ORG_A)));
    const dek = await provider.unwrap(row!.dekWrapped!, row!.kekVersionId!);
    const rewrapped = await provider.wrap(dek);
    await db
      .update(receipts)
      .set({ dekWrapped: rewrapped.wrapped, kekVersionId: rewrapped.kekVersionId })
      .where(and(eq(receipts.id, receiptId), eq(receipts.orgId, ORG_A)));

    const [after] = await db
      .select({ kekVersionId: receipts.kekVersionId })
      .from(receipts)
      .where(and(eq(receipts.id, receiptId), eq(receipts.orgId, ORG_A)));
    expect(after?.kekVersionId).toBe("v2");

    const res = await app.inject({
      method: "GET",
      url: `/v1/donations/${donationId}/receipt/download`,
      headers: authHeader(signToken(app)),
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(STUB_PDF_BYTES)).toBe(true);
  });

  it("serves a row whose plaintext_length column is NULL — Content-Length from the verified count (T3/L4)", async () => {
    // Legacy-writer simulation: the column is advisory metadata; the
    // header comes from the byte count the verification pass measured,
    // so it is present and exact even when the column is NULL.
    const { donationId } = await createEncryptedReceiptFixture({ nullPlaintextLength: true });

    const res = await app.inject({
      method: "GET",
      url: `/v1/donations/${donationId}/receipt/download`,
      headers: authHeader(signToken(app)),
    });

    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(STUB_PDF_BYTES)).toBe(true);
    expect(res.headers["content-length"]).toBe(String(STUB_PDF_BYTES.length));
  });

  it("still decrypts when the feature flag is OFF — the flag only gates NEW encryption (T5)", async () => {
    // Make the off-state explicit (it is also the seeded default): an
    // encrypted row must stay downloadable after the feature is turned
    // off, otherwise a rollback would brick every already-encrypted
    // receipt.
    await db.execute(
      sql`UPDATE feature_flags SET enabled = FALSE WHERE key = 'donation.receipt_envelope_encryption'`,
    );
    const { donationId } = await createEncryptedReceiptFixture();

    const res = await app.inject({
      method: "GET",
      url: `/v1/donations/${donationId}/receipt/download`,
      headers: authHeader(signToken(app)),
    });

    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(STUB_PDF_BYTES)).toBe(true);
  });
});

describe("Encrypted receipt download — fail-closed paths", () => {
  it("502s on a tampered auth tag and leaks neither plaintext nor ciphertext", async () => {
    const { donationId, ciphertext } = await createEncryptedReceiptFixture({
      corruptAuthTag: true,
    });

    const res = await app.inject({
      method: "GET",
      url: `/v1/donations/${donationId}/receipt/download`,
      headers: authHeader(signToken(app)),
    });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({
      type: expect.any(String),
      title: "Bad Gateway",
      status: 502,
      detail: expect.any(String),
    });
    // The response body must contain NO byte run of the plaintext nor
    // of the raw ciphertext — the whole point of the pre-verification
    // pass (GCM would otherwise have streamed plaintext before the tag
    // check fired at stream end).
    expect(res.rawPayload.includes(STUB_PDF_BYTES)).toBe(false);
    expect(res.rawPayload.includes(ciphertext)).toBe(false);
    expect(res.rawPayload.includes(Buffer.from("%PDF"))).toBe(false);
  });

  it("502s when the row's kek_version_id is unknown to the keyring", async () => {
    const { donationId } = await createEncryptedReceiptFixture({
      kekVersionId: "v9",
      wrapUnder: KEK_V1,
    });
    mockedFetchReceipt.mockClear();

    const res = await app.inject({
      method: "GET",
      url: `/v1/donations/${donationId}/receipt/download`,
      headers: authHeader(signToken(app)),
    });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ title: "Bad Gateway", status: 502 });
    // Unwrap fails before any S3 hit — the object is never fetched.
    expect(mockedFetchReceipt).not.toHaveBeenCalled();
  });

  it("502s (fail-closed, never a plaintext-path fallthrough) on an unknown encryption scheme", async () => {
    const { donationId, receiptId, ciphertext } = await createEncryptedReceiptFixture();
    await db
      .update(receipts)
      .set({ encryptionScheme: "dek-aes256gcm.v99" })
      .where(and(eq(receipts.id, receiptId), eq(receipts.orgId, ORG_A)));
    mockedFetchReceipt.mockClear();

    const res = await app.inject({
      method: "GET",
      url: `/v1/donations/${donationId}/receipt/download`,
      headers: authHeader(signToken(app)),
    });

    expect(res.statusCode).toBe(502);
    expect(mockedFetchReceipt).not.toHaveBeenCalled();
    expect(res.rawPayload.includes(ciphertext)).toBe(false);
  });

  it("502s on a ciphertext bound to ANOTHER tenant's AAD — cross-org transplant fails tag verification (D1)", async () => {
    // Simulate a transplanted crypto tuple: the object was encrypted
    // with a different org's id as AAD. The serving context (ORG_A, from
    // the JWT) supplies its own orgId, so verification must fail.
    const { donationId } = await createEncryptedReceiptFixture({
      aad: Buffer.from("00000000-0000-0000-0000-0000000000bb"),
    });

    const res = await app.inject({
      method: "GET",
      url: `/v1/donations/${donationId}/receipt/download`,
      headers: authHeader(signToken(app)),
    });

    expect(res.statusCode).toBe(502);
    expect(res.rawPayload.includes(STUB_PDF_BYTES)).toBe(false);
    expect(res.rawPayload.includes(Buffer.from("%PDF"))).toBe(false);
  });

  it("502s cleanly when the verification GET succeeds but the streaming GET fails (T2)", async () => {
    const { donationId, ciphertext } = await createEncryptedReceiptFixture();
    mockedFetchReceipt.mockClear();
    let call = 0;
    mockedFetchReceipt.mockImplementation(async () => {
      call += 1;
      if (call >= 2) {
        throw Object.assign(new Error("connection reset"), { name: "TimeoutError" });
      }
      return { body: Readable.from(ciphertext), contentLength: ciphertext.length };
    });

    const res = await app.inject({
      method: "GET",
      url: `/v1/donations/${donationId}/receipt/download`,
      headers: authHeader(signToken(app)),
    });

    // Headers were not flushed yet — the failure surfaces as the same
    // clean 502 as the legacy missing-object path.
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ title: "Bad Gateway", status: 502 });
    expect(mockedFetchReceipt).toHaveBeenCalledTimes(2);
  });

  it("destroys BOTH streams and terminates the response when the S3 body errors mid-second-pass (T2/H1)", async () => {
    // Without the H1 fix (body error → also destroy the decipher the
    // client is actually reading), the reply hangs until client timeout
    // and this test fails by TIMING OUT — inject() never resolves.
    const { donationId, ciphertext } = await createEncryptedReceiptFixture();
    mockedFetchReceipt.mockClear();

    const erratic = new PassThrough();
    let call = 0;
    mockedFetchReceipt.mockImplementation(async () => {
      call += 1;
      if (call >= 2) {
        // Streaming pass: emit a partial chunk, then fail mid-stream —
        // headers are flushed by then, so the only correct behaviour is
        // tearing both streams down.
        setTimeout(() => {
          erratic.write(ciphertext.subarray(0, 8));
          setTimeout(() => erratic.destroy(new Error("mid-stream S3 failure")), 20);
        }, 10);
        return { body: erratic, contentLength: ciphertext.length };
      }
      return { body: Readable.from(ciphertext), contentLength: ciphertext.length };
    });

    // Accept either a truncated response or a transport error — the
    // load-bearing assertions are (a) the call COMPLETES and (b) the S3
    // stream ends up destroyed.
    const outcome = await app
      .inject({
        method: "GET",
        url: `/v1/donations/${donationId}/receipt/download`,
        headers: authHeader(signToken(app)),
      })
      .then(
        (res) => ({ completed: true as const, res }),
        () => ({ completed: true as const, res: null }),
      );

    expect(outcome.completed).toBe(true);
    expect(erratic.destroyed).toBe(true);
  });

  it("the DB CHECK rejects a half-written encrypted row (scheme set, dek_wrapped NULL) — T4", async () => {
    const tokenA = signToken(app);
    const donRes = await app.inject({
      method: "POST",
      url: "/v1/donations",
      headers: authHeader(tokenA),
      payload: {
        constituentId: constituentIdA,
        amountCents: 999,
        currency: "EUR",
        paymentMethod: "wire",
        fiscalYear: 2026,
      },
    });
    const donationId = donRes.json<{ data: { id: string } }>().data.id;
    createdDonationIds.push(donationId);

    // Owner pool on purpose: prove the constraint exists in the DB, not
    // just in application code.
    const err = await db
      .insert(receipts)
      .values({
        orgId: ORG_A,
        donationId,
        receiptNumber: `REC-2026-CHK-${Date.now().toString(36)}`,
        fiscalYear: 2026,
        s3Path: `${ORG_A}/receipts/check-test.pdf`,
        status: "generated",
        encryptionScheme: RECEIPT_ENCRYPTION_SCHEME_V1,
        // dek_wrapped / kek_version_id / iv / auth_tag deliberately NULL
      })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeTruthy();
    // Postgres check_violation — the code may sit on the error itself or
    // on its `cause` depending on the driver/ORM wrapping.
    const record = err as { code?: string; cause?: { code?: string }; message?: string };
    const pgCode = record.code ?? record.cause?.code;
    expect(pgCode).toBe("23514");
  });
});

describe("Legacy (unencrypted) receipt download — non-regression", () => {
  it("scheme NULL streams the object as-is with the S3 content length", async () => {
    const tokenA = signToken(app);
    const donRes = await app.inject({
      method: "POST",
      url: "/v1/donations",
      headers: authHeader(tokenA),
      payload: {
        constituentId: constituentIdA,
        amountCents: 3000,
        currency: "EUR",
        paymentMethod: "wire",
        fiscalYear: 2026,
      },
    });
    const donationId = donRes.json<{ data: { id: string } }>().data.id;
    createdDonationIds.push(donationId);
    const receiptNumber = `REC-2026-LEG-${Date.now().toString(36)}`;
    await withTenantContext(ORG_A, async (tx) => {
      await tx.insert(receipts).values({
        orgId: ORG_A,
        donationId,
        receiptNumber,
        fiscalYear: 2026,
        s3Path: `${ORG_A}/receipts/${receiptNumber}.pdf`,
        status: "generated",
      });
    });
    mockedFetchReceipt.mockClear();
    mockedFetchReceipt.mockImplementation(async () => ({
      body: Readable.from(STUB_PDF_BYTES),
      contentLength: STUB_PDF_BYTES.length,
    }));

    const res = await app.inject({
      method: "GET",
      url: `/v1/donations/${donationId}/receipt/download`,
      headers: authHeader(tokenA),
    });

    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(STUB_PDF_BYTES)).toBe(true);
    expect(res.headers["content-length"]).toBe(String(STUB_PDF_BYTES.length));
    // Single S3 GET — no verification pass on the legacy path.
    expect(mockedFetchReceipt).toHaveBeenCalledTimes(1);
  });
});
