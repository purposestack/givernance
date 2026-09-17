import { constituents, donations, receipts } from "@givernance/shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../lib/db.js";

// Mock S3 upload before importing the processor. The processor also
// imports `uploadEncryptedReceiptPdf` (issue #228) — it stays uncalled
// in this suite (the envelope flag is default-off) but the partial mock
// factory must still provide it or the import explodes.
vi.mock("../../lib/s3.js", () => ({
  uploadReceiptPdf: vi.fn().mockResolvedValue("test-org/receipts/REC-2026-0001.pdf"),
  uploadEncryptedReceiptPdf: vi.fn().mockResolvedValue("test-org/receipts/REC-2026-0001.pdf"),
}));

// Import processor after mocking
const { processGenerateReceipt } = await import("../../processors/generate-receipt.js");

// Use a unique org ID to avoid collisions with parallel API tests
const ORG_ID = "00000000-0000-0000-0000-00000000000a";

let constituentId: string;
let donationId: string;

function makeMockJob(data: Record<string, unknown>) {
  return {
    data,
    id: "test-job-1",
    log: vi.fn(),
  } as never;
}

beforeAll(async () => {
  // Ensure test tenant exists
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug) VALUES (${ORG_ID}, 'Worker Test Org', 'worker-test-org') ON CONFLICT (id) DO NOTHING`,
  );

  // Create a constituent
  const [c] = await db
    .insert(constituents)
    .values({
      orgId: ORG_ID,
      firstName: "Worker",
      lastName: "Test",
      email: "worker-test@example.org",
      type: "donor",
    })
    .returning();
  constituentId = c!.id;

  // Create a donation
  const [d] = await db
    .insert(donations)
    .values({
      orgId: ORG_ID,
      constituentId,
      amountCents: 5000,
      currency: "EUR",
      exchangeRate: "1",
      amountBaseCents: 5000,
      paymentMethod: "wire",
      donatedAt: new Date("2026-01-15"),
      fiscalYear: 2026,
    })
    .returning();
  donationId = d!.id;
});

afterAll(async () => {
  // Cleanup test data in reverse dependency order
  await db.execute(sql`DELETE FROM receipts WHERE org_id = ${ORG_ID}`);
  await db.execute(sql`DELETE FROM receipt_sequences WHERE org_id = ${ORG_ID}`).catch(() => {});
  await db.execute(sql`DELETE FROM donations WHERE org_id = ${ORG_ID}`);
  await db.execute(sql`DELETE FROM constituents WHERE org_id = ${ORG_ID}`);
});

describe("processGenerateReceipt", () => {
  it("generates a receipt, uploads to S3, and inserts a DB record", async () => {
    const job = makeMockJob({
      donationId,
      orgId: ORG_ID,
      fiscalYear: 2026,
      locale: "en",
    });

    const result = await processGenerateReceipt(job);

    // Verify return value
    expect(result).toHaveProperty("receiptNumber");
    expect(result).toHaveProperty("s3Path");
    expect(result.receiptNumber).toMatch(/^REC-2026-\d{4}$/);

    // Verify DB record was created
    const [receipt] = await db
      .select()
      .from(receipts)
      .where(and(eq(receipts.donationId, donationId), eq(receipts.orgId, ORG_ID)));

    expect(receipt).toBeTruthy();
    expect(receipt?.status).toBe("generated");
    expect(receipt?.receiptNumber).toBe(result.receiptNumber);
    expect(receipt?.s3Path).toContain("receipts/");

    // Verify the donation was updated with receipt info
    const [updatedDonation] = await db
      .select()
      .from(donations)
      .where(and(eq(donations.id, donationId), eq(donations.orgId, ORG_ID)));

    expect(updatedDonation?.receiptNumber).toBe(result.receiptNumber);
  });

  // Issue #612 — a receipt number is a gapless legal sequence; a re-run
  // (BullMQ retry after a lost ack, re-emitted event, BullBoard replay)
  // must not burn a second one.
  it("is idempotent per donation: a re-run returns the existing receipt and allocates no new number", async () => {
    const readSeq = async () => {
      const res = await db.execute<{ next_val: number }>(
        sql`SELECT next_val FROM receipt_sequences WHERE org_id = ${ORG_ID} AND fiscal_year = 2026`,
      );
      return Number(res.rows[0]?.next_val ?? 0);
    };
    const [before] = await db
      .select()
      .from(receipts)
      .where(and(eq(receipts.donationId, donationId), eq(receipts.orgId, ORG_ID)));
    expect(before).toBeTruthy();
    const seqBefore = await readSeq();

    const result = await processGenerateReceipt(
      makeMockJob({ donationId, orgId: ORG_ID, locale: "en" }),
    );

    expect(result.receiptNumber).toBe(before?.receiptNumber);
    expect(result.s3Path).toBe(before?.s3Path);
    const rows = await db
      .select()
      .from(receipts)
      .where(and(eq(receipts.donationId, donationId), eq(receipts.orgId, ORG_ID)));
    expect(rows).toHaveLength(1);
    expect(await readSeq()).toBe(seqBefore);
  });

  // Issue #612 — the fiscal year belongs to the donation, not to the wall
  // clock at routing time (which older builds stamped into the payload).
  it("derives the fiscal year from donated_at (UTC), ignoring a stale payload fiscalYear", async () => {
    const [d] = await db
      .insert(donations)
      .values({
        orgId: ORG_ID,
        constituentId,
        amountCents: 2500,
        currency: "EUR",
        exchangeRate: "1",
        amountBaseCents: 2500,
        paymentMethod: "wire",
        donatedAt: new Date("2025-12-31T22:30:00Z"),
        // fiscalYear left NULL — e.g. a Stripe-webhook row from before the column was stamped
      })
      .returning();

    // Legacy job shape: processed in January, payload says 2026.
    const result = await processGenerateReceipt(
      makeMockJob({ donationId: d!.id, orgId: ORG_ID, fiscalYear: 2026, locale: "en" }),
    );

    expect(result.receiptNumber).toMatch(/^REC-2025-\d{4}$/);
    const [receipt] = await db
      .select()
      .from(receipts)
      .where(and(eq(receipts.donationId, d!.id), eq(receipts.orgId, ORG_ID)));
    expect(receipt?.fiscalYear).toBe(2025);
  });

  it("prefers the donation's explicit fiscal_year over the donated_at year", async () => {
    const [d] = await db
      .insert(donations)
      .values({
        orgId: ORG_ID,
        constituentId,
        amountCents: 1000,
        currency: "EUR",
        exchangeRate: "1",
        amountBaseCents: 1000,
        paymentMethod: "wire",
        donatedAt: new Date("2026-01-03T10:00:00Z"),
        fiscalYear: 2024,
      })
      .returning();

    const result = await processGenerateReceipt(
      makeMockJob({ donationId: d!.id, orgId: ORG_ID, locale: "en" }),
    );

    expect(result.receiptNumber).toMatch(/^REC-2024-\d{4}$/);
  });

  it("throws when donation does not exist", async () => {
    const job = makeMockJob({
      donationId: "00000000-0000-0000-0000-ffffffffffff",
      orgId: ORG_ID,
      fiscalYear: 2026,
      locale: "en",
    });

    await expect(processGenerateReceipt(job)).rejects.toThrow("Donation");
  });

  it("throws when org does not match", async () => {
    const otherOrg = "00000000-0000-0000-0000-000000000099";
    await db.execute(
      sql`INSERT INTO tenants (id, name, slug) VALUES (${otherOrg}, 'Other Org', 'other-org') ON CONFLICT (id) DO NOTHING`,
    );

    const job = makeMockJob({
      donationId,
      orgId: otherOrg,
      fiscalYear: 2026,
      locale: "en",
    });

    await expect(processGenerateReceipt(job)).rejects.toThrow();
  });
});
