/** Job processor — generate tax receipt PDF for a donation */

import type { GenerateReceiptJob } from "@givernance/shared/jobs";
import { constituents, donations, receipts } from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../lib/db.js";
import { uploadReceiptPdf } from "../lib/s3.js";
import { generateReceiptPdf } from "../services/pdf.js";

/**
 * Generate a sequential receipt number for the given org and fiscal year.
 * Pattern: REC-YYYY-NNNN (zero-padded sequence).
 */
async function nextReceiptNumber(orgId: string, fiscalYear: number): Promise<string> {
  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(receipts)
    .where(and(eq(receipts.orgId, orgId), eq(receipts.fiscalYear, fiscalYear)));

  const seq = Number(result[0]?.count ?? 0) + 1;
  return `REC-${fiscalYear}-${String(seq).padStart(4, "0")}`;
}

/** Generate a tax receipt PDF and store it */
export async function processGenerateReceipt(job: Job<GenerateReceiptJob["data"]>) {
  const { donationId, orgId, fiscalYear } = job.data;

  job.log(`Generating receipt for donation ${donationId} (org: ${orgId}, year: ${fiscalYear})`);

  // CRITICAL RLS: Worker bypasses RLS — enforce tenant isolation explicitly
  const [donation] = await db
    .select()
    .from(donations)
    .where(and(eq(donations.id, donationId), eq(donations.orgId, orgId)));

  if (!donation) {
    throw new Error(`Donation ${donationId} not found for org ${orgId}`);
  }

  const [constituent] = await db
    .select({
      firstName: constituents.firstName,
      lastName: constituents.lastName,
      email: constituents.email,
    })
    .from(constituents)
    .where(and(eq(constituents.id, donation.constituentId), eq(constituents.orgId, orgId)));

  if (!constituent) {
    throw new Error(`Constituent ${donation.constituentId} not found for org ${orgId}`);
  }

  const receiptNumber = await nextReceiptNumber(orgId, fiscalYear);

  const pdfBuffer = await generateReceiptPdf({
    receiptNumber,
    orgId,
    donorName: `${constituent.firstName} ${constituent.lastName}`,
    donorEmail: constituent.email,
    amountCents: donation.amountCents,
    currency: donation.currency,
    donatedAt: donation.donatedAt,
    fiscalYear,
  });

  const s3Path = await uploadReceiptPdf(orgId, receiptNumber, pdfBuffer);

  // Insert receipt record
  await db.insert(receipts).values({
    orgId,
    donationId,
    receiptNumber,
    fiscalYear,
    s3Path,
    status: "generated",
  });

  // Update donation with receipt info
  await db
    .update(donations)
    .set({
      receiptNumber,
      receiptAmount: String(donation.amountCents / 100),
      updatedAt: new Date(),
    })
    .where(and(eq(donations.id, donationId), eq(donations.orgId, orgId)));

  job.log(`Receipt ${receiptNumber} generated and uploaded to ${s3Path}`);

  return { receiptNumber, s3Path };
}
