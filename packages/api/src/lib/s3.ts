/** S3/MinIO client for generating presigned download URLs */

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

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

/** Generate a presigned URL for downloading a receipt PDF (expires in 15 minutes) */
export async function getReceiptPresignedUrl(s3Path: string): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: RECEIPTS_BUCKET,
    Key: s3Path,
  });

  return getSignedUrl(s3, command, { expiresIn: 900 });
}
