/** S3/MinIO client for fetching receipt PDFs server-side */

import type { Readable } from "node:stream";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
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

/**
 * Fetch a receipt PDF from MinIO/S3. Returns the body as a Node Readable
 * (Fastify pipes it natively through `reply.send`) plus content metadata
 * for the response headers.
 *
 * The route streams this through the API instead of redirecting the browser
 * to a presigned URL because (a) presigned URLs bake the S3 hostname into
 * the SigV4 signature, and on staging that's `givernance-minio:9000` — only
 * resolvable inside the Docker network, and (b) the donor-visible URL must
 * stay on the app's own apex/subdomain to keep the trust path consistent.
 * See issue #214 for the design decision and rejected alternatives.
 */
export async function fetchReceiptObject(s3Path: string): Promise<{
  body: Readable;
  contentLength: number | undefined;
}> {
  const command = new GetObjectCommand({
    Bucket: env.S3_RECEIPTS_BUCKET,
    Key: s3Path,
  });
  const response = await s3.send(command);
  // The AWS SDK types `Body` as a union (Readable | Blob | ReadableStream)
  // because the same SDK runs in Node and the browser. In Node the runtime
  // value is always a Node Readable.
  const body = response.Body as Readable | undefined;
  if (!body) {
    throw new Error(`S3 object missing body: ${s3Path}`);
  }
  return { body, contentLength: response.ContentLength };
}

/**
 * Fetch a campaign export ZIP from MinIO/S3 — same streaming-through-API
 * rationale as `fetchReceiptObject` (issue #214). The route
 * `GET /v1/campaigns/:id/postal-exports/:exportId/download` pipes this
 * through `reply.send` with a `content-disposition: attachment` header.
 */
export async function fetchCampaignObject(s3Path: string): Promise<{
  body: Readable;
  contentLength: number | undefined;
}> {
  const command = new GetObjectCommand({
    Bucket: env.S3_CAMPAIGNS_BUCKET,
    Key: s3Path,
  });
  const response = await s3.send(command);
  const body = response.Body as Readable | undefined;
  if (!body) {
    throw new Error(`S3 object missing body: ${s3Path}`);
  }
  return { body, contentLength: response.ContentLength };
}
