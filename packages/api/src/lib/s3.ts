/** S3/MinIO client for generating presigned download URLs */

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
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

export const RECEIPT_URL_TTL_SECONDS = 900;

/**
 * Generate a presigned URL for downloading a receipt PDF (default TTL 15 min).
 * Returns both the URL and the absolute expiry so clients can cache the URL
 * safely and refetch before it expires — issue #56 API minor.
 */
export async function getReceiptPresignedUrl(
  s3Path: string,
): Promise<{ url: string; expiresAt: Date }> {
  const command = new GetObjectCommand({
    Bucket: env.S3_RECEIPTS_BUCKET,
    Key: s3Path,
  });

  const url = await getSignedUrl(s3, command, { expiresIn: RECEIPT_URL_TTL_SECONDS });
  const expiresAt = new Date(Date.now() + RECEIPT_URL_TTL_SECONDS * 1000);
  return { url, expiresAt };
}
