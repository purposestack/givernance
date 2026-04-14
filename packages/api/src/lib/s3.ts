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

/** Generate a presigned URL for downloading a receipt PDF (expires in 15 minutes) */
export async function getReceiptPresignedUrl(s3Path: string): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: env.S3_RECEIPTS_BUCKET,
    Key: s3Path,
  });

  return getSignedUrl(s3, command, { expiresIn: 900 });
}
