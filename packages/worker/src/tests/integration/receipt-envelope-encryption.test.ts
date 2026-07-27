/**
 * Integration tests — receipt generation under the
 * `donation.receipt_envelope_encryption` flag (issue #228).
 *
 * Modelled on `receipt-processor.test.ts`. Dedicated org UUID (…022a)
 * so parallel API tests and the sibling worker suite never collide.
 * The worker vitest config runs files sequentially
 * (`fileParallelism: false`), so flipping the platform flag here and
 * restoring it in afterAll cannot race the flag-off sibling suite.
 */

import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import {
  createDecryptStream,
  LocalKekProvider,
  RECEIPT_ENCRYPTION_SCHEME_V1,
} from "@givernance/shared/lib/receipt-crypto";
import { constituents, donations, receipts } from "@givernance/shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../lib/db.js";

// Partial mock of the worker S3 module: capture what the processor
// uploads instead of hitting a real bucket. `uploadEncryptedReceiptPdf`
// drains the stream into a buffer so the tests can assert the uploaded
// bytes are ciphertext and round-trip them through the decipher.
const { mockedUploadPlain, mockedUploadEncrypted, getLastEncryptedUpload, resetCaptures } =
  vi.hoisted(() => {
    let lastEncrypted: Buffer | null = null;
    const drain = async (stream: NodeJS.ReadableStream): Promise<Buffer> => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk as Buffer);
      }
      return Buffer.concat(chunks);
    };
    return {
      mockedUploadPlain: vi.fn(
        async (tenantId: string, receiptNumber: string, doc: NodeJS.ReadableStream) => {
          await drain(doc);
          return `${tenantId}/receipts/${receiptNumber}.pdf`;
        },
      ),
      mockedUploadEncrypted: vi.fn(
        async (tenantId: string, receiptNumber: string, doc: NodeJS.ReadableStream) => {
          lastEncrypted = await drain(doc);
          return `${tenantId}/receipts/${receiptNumber}.pdf`;
        },
      ),
      getLastEncryptedUpload: () => lastEncrypted,
      resetCaptures: () => {
        lastEncrypted = null;
      },
    };
  });

vi.mock("../../lib/s3.js", () => ({
  uploadReceiptPdf: mockedUploadPlain,
  uploadEncryptedReceiptPdf: mockedUploadEncrypted,
}));

const { processGenerateReceipt } = await import("../../processors/generate-receipt.js");
const { processRewrapReceiptDeks } = await import("../../processors/rewrap-receipt-deks.js");

const FLAG_KEY = "donation.receipt_envelope_encryption";
const ORG_ID = "00000000-0000-0000-0000-00000000022a";

const KEYRING_V1 = randomBytes(32).toString("base64");
const KEYRING_V2 = randomBytes(32).toString("base64");
const KEYRING = JSON.stringify({ v1: KEYRING_V1 });

let constituentId: string;

const RECEIPT_ENV_KEYS = [
  "RECEIPT_ENCRYPTION_KEK_PROVIDER",
  "RECEIPT_ENCRYPTION_LOCAL_KEYRING",
  "RECEIPT_ENCRYPTION_LOCAL_ACTIVE_VERSION",
] as const;

function clearReceiptEnv() {
  for (const key of RECEIPT_ENV_KEYS) {
    delete process.env[key];
  }
}

function setLocalKekEnv() {
  process.env.RECEIPT_ENCRYPTION_KEK_PROVIDER = "local";
  process.env.RECEIPT_ENCRYPTION_LOCAL_KEYRING = KEYRING;
  process.env.RECEIPT_ENCRYPTION_LOCAL_ACTIVE_VERSION = "v1";
}

async function setFlag(enabled: boolean) {
  // The seed migration (0093) provisions the row; upsert defensively so
  // a stale local test DB without the seed still exercises the path.
  await db.execute(
    sql`INSERT INTO feature_flags (key, enabled, label, description, scope, tenant_override_allowed, public)
        VALUES (${FLAG_KEY}, ${enabled}, 'Receipt envelope encryption', 'test', 'platform', FALSE, FALSE)
        ON CONFLICT (key) DO UPDATE SET enabled = ${enabled}`,
  );
}

async function createDonation(): Promise<string> {
  const [d] = await db
    .insert(donations)
    .values({
      orgId: ORG_ID,
      constituentId,
      amountCents: 7500,
      currency: "EUR",
      exchangeRate: "1",
      amountBaseCents: 7500,
      paymentMethod: "wire",
      donatedAt: new Date("2026-02-01"),
      fiscalYear: 2026,
    })
    .returning();
  return d!.id;
}

function makeMockJob(data: Record<string, unknown>) {
  return {
    data,
    id: "test-envelope-job",
    log: vi.fn(),
  } as never;
}

beforeAll(async () => {
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug) VALUES (${ORG_ID}, 'Envelope Test Org', 'envelope-test-org') ON CONFLICT (id) DO NOTHING`,
  );
  const [c] = await db
    .insert(constituents)
    .values({
      orgId: ORG_ID,
      firstName: "Envelope",
      lastName: "Donor",
      email: "envelope-donor@example.org",
      type: "donor",
    })
    .returning();
  constituentId = c!.id;
});

beforeEach(() => {
  clearReceiptEnv();
  resetCaptures();
  mockedUploadPlain.mockClear();
  mockedUploadEncrypted.mockClear();
});

afterEach(async () => {
  // Restore the seeded default so sibling suites (receipt-processor)
  // always run flag-off.
  await setFlag(false);
  clearReceiptEnv();
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM receipts WHERE org_id = ${ORG_ID}`);
  await db.execute(sql`DELETE FROM receipt_sequences WHERE org_id = ${ORG_ID}`).catch(() => {});
  await db.execute(sql`DELETE FROM donations WHERE org_id = ${ORG_ID}`);
  await db.execute(sql`DELETE FROM constituents WHERE org_id = ${ORG_ID}`);
});

describe("processGenerateReceipt — envelope encryption flag OFF", () => {
  it("keeps today's plaintext upload and leaves encryption columns NULL", async () => {
    await setFlag(false);
    const donationId = await createDonation();

    const result = await processGenerateReceipt(
      makeMockJob({ donationId, orgId: ORG_ID, fiscalYear: 2026, locale: "en" }),
    );
    expect(result.receiptNumber).toMatch(/^REC-2026-\d{4}$/);

    expect(mockedUploadPlain).toHaveBeenCalledTimes(1);
    expect(mockedUploadEncrypted).not.toHaveBeenCalled();

    const [receipt] = await db
      .select()
      .from(receipts)
      .where(and(eq(receipts.donationId, donationId), eq(receipts.orgId, ORG_ID)));
    expect(receipt?.status).toBe("generated");
    expect(receipt?.encryptionScheme).toBeNull();
    expect(receipt?.dekWrapped).toBeNull();
    expect(receipt?.kekVersionId).toBeNull();
    expect(receipt?.encryptionIv).toBeNull();
    expect(receipt?.encryptionAuthTag).toBeNull();
    expect(receipt?.plaintextLength).toBeNull();
  });
});

describe("processGenerateReceipt — envelope encryption flag ON", () => {
  it("uploads ciphertext (not the PDF), fills the crypto columns, and round-trips", async () => {
    await setFlag(true);
    setLocalKekEnv();
    const donationId = await createDonation();

    await processGenerateReceipt(
      makeMockJob({ donationId, orgId: ORG_ID, fiscalYear: 2026, locale: "en" }),
    );

    expect(mockedUploadEncrypted).toHaveBeenCalledTimes(1);
    expect(mockedUploadPlain).not.toHaveBeenCalled();

    const uploaded = getLastEncryptedUpload();
    expect(uploaded).toBeTruthy();
    // The uploaded object must NOT be the plaintext PDF.
    expect(uploaded!.subarray(0, 4).toString("utf8")).not.toBe("%PDF");

    const [receipt] = await db
      .select()
      .from(receipts)
      .where(and(eq(receipts.donationId, donationId), eq(receipts.orgId, ORG_ID)));
    expect(receipt?.status).toBe("generated");
    expect(receipt?.encryptionScheme).toBe(RECEIPT_ENCRYPTION_SCHEME_V1);
    expect(receipt?.kekVersionId).toBe("v1");
    expect(receipt?.dekWrapped).toBeTruthy();
    expect(receipt?.encryptionIv).toBeTruthy();
    expect(receipt?.encryptionAuthTag).toBeTruthy();
    expect(receipt?.plaintextLength).toBeGreaterThan(0);
    // Ciphertext length equals plaintext length (GCM keystream).
    expect(uploaded!.length).toBe(receipt?.plaintextLength);

    // Round-trip: unwrap the DEK with the test keyring and decrypt the
    // captured upload — must yield a real PDF of exactly plaintext_length.
    // AAD = the row's orgId (D1): the processor binds it at encryption.
    const provider = new LocalKekProvider({ v1: KEYRING_V1 }, "v1");
    const dek = await provider.unwrap(receipt!.dekWrapped!, receipt!.kekVersionId!);
    const decipher = createDecryptStream(
      dek,
      Buffer.from(receipt!.encryptionIv!, "base64"),
      Buffer.from(receipt!.encryptionAuthTag!, "base64"),
      Buffer.from(ORG_ID),
    );
    const chunks: Buffer[] = [];
    for await (const chunk of Readable.from(uploaded!).pipe(decipher)) {
      chunks.push(chunk as Buffer);
    }
    const plaintext = Buffer.concat(chunks);
    expect(plaintext.subarray(0, 4).toString("utf8")).toBe("%PDF");
    expect(plaintext.length).toBe(receipt?.plaintextLength);
  });

  it("fails the job (no upload at all) when the KEK env is absent — fail-closed", async () => {
    await setFlag(true);
    // Deliberately NO RECEIPT_ENCRYPTION_* env.
    const donationId = await createDonation();

    await expect(
      processGenerateReceipt(
        makeMockJob({ donationId, orgId: ORG_ID, fiscalYear: 2026, locale: "en" }),
      ),
    ).rejects.toThrow(/RECEIPT_ENCRYPTION_KEK_PROVIDER/);

    // The one thing that must never happen: a plaintext fallback upload.
    expect(mockedUploadPlain).not.toHaveBeenCalled();
    expect(mockedUploadEncrypted).not.toHaveBeenCalled();

    const rows = await db
      .select()
      .from(receipts)
      .where(and(eq(receipts.donationId, donationId), eq(receipts.orgId, ORG_ID)));
    expect(rows).toHaveLength(0);
  });
});

describe("processRewrapReceiptDeks — KEK rotation sweep", () => {
  beforeEach(async () => {
    // The sweep is platform-wide by design, so give it a deterministic
    // universe: purge every encrypted receipt row (this file's earlier
    // generate tests + any stale fixtures from a crashed prior run).
    // Only this feature writes encrypted rows, worker test files run
    // sequentially, and the API package's own suite cleans up after
    // itself — so the purge is safe and lets the assertions below be
    // EXACT counts instead of >= lower bounds.
    await db.execute(sql`DELETE FROM receipts WHERE encryption_scheme IS NOT NULL`);
  });

  it("no-ops (loudly) when the flag is off", async () => {
    await setFlag(false);
    setLocalKekEnv();

    const result = await processRewrapReceiptDeks(makeMockJob({ requestedBy: "test" }));
    expect(result).toMatchObject({ skipped: true, scanned: 0, rewrapped: 0, failed: 0 });
  });

  it("force=true bypasses the flag gate — emergency rotation after the feature was turned off", async () => {
    // Encrypted rows outlive the flag: generate one while ON…
    await setFlag(true);
    setLocalKekEnv();
    const donationId = await createDonation();
    await processGenerateReceipt(
      makeMockJob({ donationId, orgId: ORG_ID, fiscalYear: 2026, locale: "en" }),
    );

    // …then turn the feature OFF and rotate the KEK under force.
    await setFlag(false);
    process.env.RECEIPT_ENCRYPTION_LOCAL_KEYRING = JSON.stringify({
      v1: KEYRING_V1,
      v2: KEYRING_V2,
    });
    process.env.RECEIPT_ENCRYPTION_LOCAL_ACTIVE_VERSION = "v2";

    const result = await processRewrapReceiptDeks(
      makeMockJob({ requestedBy: "test", force: true }),
    );
    expect(result).toMatchObject({ skipped: false, scanned: 1, rewrapped: 1, failed: 0 });

    const [after] = await db
      .select()
      .from(receipts)
      .where(and(eq(receipts.donationId, donationId), eq(receipts.orgId, ORG_ID)));
    expect(after?.kekVersionId).toBe("v2");
  });

  it("re-wraps a v1-wrapped row onto the active v2 without touching S3", async () => {
    await setFlag(true);
    // Generate an encrypted receipt under keyring v1 (active v1).
    setLocalKekEnv();
    const donationId = await createDonation();
    await processGenerateReceipt(
      makeMockJob({ donationId, orgId: ORG_ID, fiscalYear: 2026, locale: "en" }),
    );
    const [before] = await db
      .select()
      .from(receipts)
      .where(and(eq(receipts.donationId, donationId), eq(receipts.orgId, ORG_ID)));
    expect(before?.kekVersionId).toBe("v1");

    // Rotation: keyring gains v2, active flips to v2.
    process.env.RECEIPT_ENCRYPTION_LOCAL_KEYRING = JSON.stringify({
      v1: KEYRING_V1,
      v2: KEYRING_V2,
    });
    process.env.RECEIPT_ENCRYPTION_LOCAL_ACTIVE_VERSION = "v2";

    mockedUploadPlain.mockClear();
    mockedUploadEncrypted.mockClear();
    const result = await processRewrapReceiptDeks(makeMockJob({ requestedBy: "test" }));
    // Exact counts — the beforeEach purge guarantees this row is the
    // only encrypted one in the DB.
    expect(result).toMatchObject({ skipped: false, scanned: 1, rewrapped: 1, failed: 0 });

    const [after] = await db
      .select()
      .from(receipts)
      .where(and(eq(receipts.donationId, donationId), eq(receipts.orgId, ORG_ID)));
    expect(after?.kekVersionId).toBe("v2");
    expect(after?.dekWrapped).not.toBe(before?.dekWrapped);
    // Ciphertext metadata untouched — the sweep is DB-only.
    expect(after?.encryptionIv).toBe(before?.encryptionIv);
    expect(after?.encryptionAuthTag).toBe(before?.encryptionAuthTag);
    expect(after?.s3Path).toBe(before?.s3Path);
    // Zero S3 access during the sweep.
    expect(mockedUploadPlain).not.toHaveBeenCalled();
    expect(mockedUploadEncrypted).not.toHaveBeenCalled();

    // The re-wrapped blob under v2 unwraps to the SAME DEK that v1
    // wrapped — the stored ciphertext stays decryptable.
    const provider = new LocalKekProvider({ v1: KEYRING_V1, v2: KEYRING_V2 }, "v2");
    const dekBefore = await provider.unwrap(before!.dekWrapped!, "v1");
    const dekAfter = await provider.unwrap(after!.dekWrapped!, "v2");
    expect(dekAfter.equals(dekBefore)).toBe(true);
  });

  it("isolates a row wrapped under a KEK version the keyring no longer holds and still terminates (T1)", async () => {
    await setFlag(true);
    // Healthy row: wrapped under v1, still unwrappable after rotation.
    setLocalKekEnv();
    const healthyDonationId = await createDonation();
    await processGenerateReceipt(
      makeMockJob({ donationId: healthyDonationId, orgId: ORG_ID, fiscalYear: 2026, locale: "en" }),
    );

    // Poison row: kek_version_id "v0" is unknown to the keyring — the
    // realistic "old KEK version was removed too early" failure. Insert
    // directly (owner pool) with a syntactically valid crypto tuple.
    const poisonDonationId = await createDonation();
    const poisonNumber = `REC-2026-POISON-${Date.now().toString(36)}`;
    await db.insert(receipts).values({
      orgId: ORG_ID,
      donationId: poisonDonationId,
      receiptNumber: poisonNumber,
      fiscalYear: 2026,
      s3Path: `${ORG_ID}/receipts/${poisonNumber}.pdf`,
      status: "generated",
      encryptionScheme: RECEIPT_ENCRYPTION_SCHEME_V1,
      dekWrapped: Buffer.from(randomBytes(60)).toString("base64"),
      kekVersionId: "v0",
      encryptionIv: randomBytes(12).toString("base64"),
      encryptionAuthTag: randomBytes(16).toString("base64"),
      plaintextLength: 1234,
    });

    // Rotate: keyring holds v1 + v2, active v2 — v0 is gone.
    process.env.RECEIPT_ENCRYPTION_LOCAL_KEYRING = JSON.stringify({
      v1: KEYRING_V1,
      v2: KEYRING_V2,
    });
    process.env.RECEIPT_ENCRYPTION_LOCAL_ACTIVE_VERSION = "v2";

    // The sweep must terminate (no infinite loop on the sticky failed
    // row — the keyset cursor structurally advances past it), re-wrap
    // the healthy row, and leave the poison row untouched for a later
    // sweep once the keyring is fixed.
    const result = await processRewrapReceiptDeks(makeMockJob({ requestedBy: "test" }));
    expect(result).toMatchObject({ skipped: false, scanned: 2, rewrapped: 1, failed: 1 });

    const [healthy] = await db
      .select()
      .from(receipts)
      .where(and(eq(receipts.donationId, healthyDonationId), eq(receipts.orgId, ORG_ID)));
    expect(healthy?.kekVersionId).toBe("v2");

    const [poison] = await db
      .select()
      .from(receipts)
      .where(and(eq(receipts.donationId, poisonDonationId), eq(receipts.orgId, ORG_ID)));
    expect(poison?.kekVersionId).toBe("v0");
  });
});
