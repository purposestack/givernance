/** S3/MinIO client for uploading generated files (supports streaming) */

import type { Readable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { env } from "../env.js";

const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  forcePathStyle: true,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
});

/** Stream a PDFKit document directly to S3 via multipart upload */
export async function streamPdfToS3(
  bucket: string,
  key: string,
  doc: NodeJS.ReadableStream,
): Promise<string> {
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: bucket,
      Key: key,
      Body: doc as unknown as Readable,
      ContentType: "application/pdf",
      ServerSideEncryption: "AES256",
    },
  });

  await upload.done();
  return key;
}

/** Upload a receipt PDF (streamed) to the receipts bucket */
export async function uploadReceiptPdf(
  tenantId: string,
  receiptNumber: string,
  doc: NodeJS.ReadableStream,
): Promise<string> {
  const key = `${tenantId}/receipts/${receiptNumber}.pdf`;
  return streamPdfToS3(env.S3_RECEIPTS_BUCKET, key, doc);
}

/** Upload a campaign document PDF (streamed) to the campaigns bucket */
export async function uploadCampaignPdf(
  tenantId: string,
  campaignId: string,
  documentId: string,
  doc: NodeJS.ReadableStream,
): Promise<string> {
  const key = `${tenantId}/campaigns/${campaignId}/${documentId}.pdf`;
  return streamPdfToS3(env.S3_CAMPAIGNS_BUCKET, key, doc);
}
