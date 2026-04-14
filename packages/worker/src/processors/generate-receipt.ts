/** Job processor — generate tax receipt PDF for a donation */

import type { GenerateReceiptJob } from "@givernance/shared/jobs";
import { constituents, donations, receipts } from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { and, eq, sql } from "drizzle-orm";
import { withWorkerContext } from "../lib/db.js";
import { uploadReceiptPdf } from "../lib/s3.js";
import { generateReceiptPdf } from "../services/pdf.js";

/**
 * Atomically allocate the next receipt number for an org/fiscal year.
 * Uses INSERT ... ON CONFLICT ... UPDATE ... RETURNING to guarantee
 * gapless, race-free sequential numbering even under concurrency.
 * Pattern: REC-YYYY-NNNN (zero-padded sequence).
 */
async function nextReceiptNumber(
  tx: Parameters<Parameters<typeof withWorkerContext>[1]>[0],
  orgId: string,
  fiscalYear: number,
): Promise<string> {
  const result = await tx.execute(
    sql`INSERT INTO receipt_sequences (org_id, fiscal_year, next_val)
        VALUES (${orgId}, ${fiscalYear}, 1)
        ON CONFLICT ON CONSTRAINT receipt_sequences_pkey
        DO UPDATE SET next_val = receipt_sequences.next_val + 1
        RETURNING next_val`,
  );

  const rows = (result as unknown as { rows: { next_val: number }[] }).rows;
  const seq = Number(rows[0]?.next_val ?? 1);
  return `REC-${fiscalYear}-${String(seq).padStart(4, "0")}`;
}

/** Generate a tax receipt PDF and store it */
export async function processGenerateReceipt(job: Job<GenerateReceiptJob["data"]>) {
  const { donationId, orgId, fiscalYear } = job.data;

  job.log(`Generating receipt for donation ${donationId} (org: ${orgId}, year: ${fiscalYear})`);

  return withWorkerContext(orgId, async (tx) => {
    const [donation] = await tx
      .select()
      .from(donations)
      .where(and(eq(donations.id, donationId), eq(donations.orgId, orgId)));

    if (!donation) {
      throw new Error(`Donation ${donationId} not found for org ${orgId}`);
    }

    const [constituent] = await tx
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

    const receiptNumber = await nextReceiptNumber(tx, orgId, fiscalYear);

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

    await tx.insert(receipts).values({
      orgId,
      donationId,
      receiptNumber,
      fiscalYear,
      s3Path,
      status: "generated",
    });

    await tx
      .update(donations)
      .set({
        receiptNumber,
        receiptAmount: String(donation.amountCents / 100),
        updatedAt: new Date(),
      })
      .where(and(eq(donations.id, donationId), eq(donations.orgId, orgId)));

    job.log(`Receipt ${receiptNumber} generated and uploaded to ${s3Path}`);

    return { receiptNumber, s3Path };
  });
}
