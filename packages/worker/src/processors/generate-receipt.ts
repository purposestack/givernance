/** Job processor — generate tax receipt PDF for a donation */

import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import type { GenerateReceiptJob } from "@givernance/shared/jobs";
import {
  createByteCounter,
  createEncryptStream,
  generateDek,
  type KekProvider,
  RECEIPT_ENCRYPTION_SCHEME_V1,
} from "@givernance/shared/lib/receipt-crypto";
import { constituents, donations, receipts } from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { and, eq, sql } from "drizzle-orm";
import { withWorkerContext } from "../lib/db.js";
import { isFlagEnabled } from "../lib/flags.js";
import { jobLogger } from "../lib/logger.js";
import { getReceiptKekProvider } from "../lib/receipt-kek.js";
import { uploadEncryptedReceiptPdf, uploadReceiptPdf } from "../lib/s3.js";
import { extractTraceId } from "../lib/trace-context.js";
import { createReceiptPdfStream } from "../services/pdf.js";

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
export async function processGenerateReceipt(
  job: Job<GenerateReceiptJob["data"] & { traceparent?: string }>,
) {
  const { donationId, orgId, fiscalYear, traceparent } = job.data;

  // Structured pino child — `job.log(...)` only reaches BullBoard/Redis; pino
  // reaches Loki with typed fields (issue #56 Platform #10).
  const log = jobLogger({
    tenantId: orgId,
    jobId: job.id,
    traceId: extractTraceId(traceparent),
  });

  log.info({ donationId, fiscalYear }, "Generating receipt");
  // Duplicate into BullBoard so operators poking at a single job still see progress.
  job.log(`Generating receipt for donation ${donationId} (org: ${orgId}, year: ${fiscalYear})`);

  // Envelope encryption gate (issue #228) — evaluated at pickup, BEFORE any
  // upload. Platform-scoped flag, so the global read is the full answer.
  // With the flag ON, resolve the KEK provider NOW: a misconfigured KEK must
  // fail the job here, before a receipt number is allocated and before any
  // byte reaches S3 — NEVER fall back to a plaintext upload (fail-closed).
  const envelopeOn = await isFlagEnabled(FEATURE_FLAG_KEYS.DONATION_RECEIPT_ENVELOPE_ENCRYPTION);
  let kekProvider: KekProvider | null = null;
  if (envelopeOn) {
    kekProvider = getReceiptKekProvider();
  }

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

    const pdfStream = createReceiptPdfStream({
      receiptNumber,
      orgId,
      donorName: `${constituent.firstName} ${constituent.lastName}`,
      donorEmail: constituent.email,
      amountCents: donation.amountCents,
      currency: donation.currency,
      donatedAt: donation.donatedAt,
      fiscalYear,
    });

    let s3Path: string;
    let encryptionColumns: {
      encryptionScheme: string;
      dekWrapped: string;
      kekVersionId: string;
      encryptionIv: string;
      encryptionAuthTag: string;
      plaintextLength: number;
    } | null = null;

    if (kekProvider) {
      // Envelope path (issue #228): pdf → byte counter → AES-256-GCM
      // cipher → S3, all streaming (nothing buffers the whole PDF). The
      // S3 object is PURE ciphertext; IV + auth tag go into the receipts
      // row. The auth tag only exists once `Upload` has fully consumed
      // the cipher stream, so it's read strictly after the upload.
      const dek = generateDek();
      // AAD = tenant orgId (D1): binds the ciphertext to this tenant so a
      // transplanted crypto tuple fails tag verification cross-org.
      const { cipher, iv, getAuthTag } = createEncryptStream(dek, Buffer.from(orgId));
      // Latent-proofing: PDFKit sources are synchronous today (the doc is
      // fully written before the pipe), but forward a hypothetical source
      // error so the cipher — and therefore the S3 upload — fails instead
      // of hanging if that ever changes.
      pdfStream.on("error", (err) => cipher.destroy(err as Error));
      const { counter, getCount } = createByteCounter();
      const ciphertextStream = pdfStream.pipe(counter).pipe(cipher);
      s3Path = await uploadEncryptedReceiptPdf(orgId, receiptNumber, ciphertextStream);
      const { wrapped, kekVersionId } = await kekProvider.wrap(dek);
      encryptionColumns = {
        encryptionScheme: RECEIPT_ENCRYPTION_SCHEME_V1,
        dekWrapped: wrapped,
        kekVersionId,
        encryptionIv: iv.toString("base64"),
        encryptionAuthTag: getAuthTag().toString("base64"),
        plaintextLength: getCount(),
      };
    } else {
      // Flag off — byte-for-byte the pre-#228 behaviour (plaintext PDF,
      // SSE-S3 at rest, encryption columns stay NULL).
      s3Path = await uploadReceiptPdf(orgId, receiptNumber, pdfStream);
    }

    await tx.insert(receipts).values({
      orgId,
      donationId,
      receiptNumber,
      fiscalYear,
      s3Path,
      status: "generated",
      ...(encryptionColumns ?? {}),
    });

    await tx
      .update(donations)
      .set({
        receiptNumber,
        receiptAmount: String(donation.amountCents / 100),
        updatedAt: new Date(),
      })
      .where(and(eq(donations.id, donationId), eq(donations.orgId, orgId)));

    log.info(
      { receiptNumber, s3Path, envelopeEncrypted: encryptionColumns !== null },
      "Receipt generated",
    );
    job.log(`Receipt ${receiptNumber} generated and uploaded to ${s3Path}`);

    return { receiptNumber, s3Path };
  });
}
