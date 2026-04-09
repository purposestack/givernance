/** Job processor — generate tax receipt PDF for a donation */

import type { GenerateReceiptJob } from "@givernance/shared/jobs";
import type { Job } from "bullmq";

/** Generate a tax receipt PDF and store it */
export async function processGenerateReceipt(job: Job<GenerateReceiptJob["data"]>) {
  const { donationId, orgId, fiscalYear, locale } = job.data;

  job.log(
    `Generating receipt for donation ${donationId} (org: ${orgId}, year: ${fiscalYear}, locale: ${locale})`,
  );

  // TODO: fetch donation + constituent data from DB
  // TODO: render PDF from template
  // TODO: upload PDF to S3/MinIO
  // TODO: update donation record with receipt number

  return { receiptNumber: `STUB-${fiscalYear}-${donationId.slice(0, 8)}` };
}
