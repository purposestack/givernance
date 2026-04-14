/** S3/MinIO client for uploading generated files */

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
  region: process.env.S3_REGION ?? "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "minioadmin",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "minioadmin",
  },
});

const RECEIPTS_BUCKET = process.env.S3_RECEIPTS_BUCKET ?? "receipts";

/** Upload a PDF buffer to the receipts bucket */
export async function uploadReceiptPdf(
  tenantId: string,
  receiptNumber: string,
  pdfBuffer: Buffer,
): Promise<string> {
  const key = `${tenantId}/receipts/${receiptNumber}.pdf`;

  await s3.send(
    new PutObjectCommand({
      Bucket: RECEIPTS_BUCKET,
      Key: key,
      Body: pdfBuffer,
      ContentType: "application/pdf",
    }),
  );

  return key;
}
