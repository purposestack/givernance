/** S3/MinIO client for fetching receipt PDFs server-side */

import type { Readable } from "node:stream";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
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

// ─── Branding bucket helpers (Epic #286) ───────────────────────────────────
//
// The branding bucket is **public-read** at the bucket level so donor-
// facing surfaces (Keycloak login template, donation page) can hit
// object URLs directly with `Cache-Control: public, max-age=31536000,
// immutable`. The keys themselves are content-addressed
// (`{org_id}/logo/{logo_id}/{variant}.{ext}`) so a stale CDN edge can
// never leak a logo across logo versions.
//
// IMPORTANT — defense-in-depth:
//   - We do NOT set `ACL: private` on these uploads (would override the
//     bucket-level policy and 403 the donor).
//   - We do NOT set SSE — encryption-at-rest is enabled at the bucket
//     level (Scaleway default + MinIO via `MINIO_KMS_SECRET_KEY`); a
//     per-object override would force a key dance for a value that
//     is, by design, public.

/**
 * Upload a branding asset (original or derived variant) to the public-
 * read branding bucket. The Cache-Control + Content-Type are baked in
 * here so every upload site stays consistent.
 */
export async function putBrandingObject(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<string> {
  await s3.send(
    new PutObjectCommand({
      Bucket: env.S3_BRANDING_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      // Long-lived public cache — content-addressed keys make this safe.
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );
  return key;
}

/**
 * Fetch a branding object as a Buffer (used by the API postal-preview
 * handler to embed the active logo in the on-the-fly PDF preview).
 * Returns `null` on 404 so callers can degrade gracefully.
 */
export async function getBrandingObject(key: string): Promise<Buffer | null> {
  try {
    const out = await s3.send(
      new GetObjectCommand({
        Bucket: env.S3_BRANDING_BUCKET,
        Key: key,
      }),
    );
    const body = out.Body as Readable | undefined;
    if (!body) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw err;
  }
}

/**
 * Delete every object under a prefix. Used by the `branding.gc_asset`
 * worker job to clean up after a soft-deleted asset (and by tenant
 * offboarding to wipe `{org_id}/`). Best-effort — we paginate the
 * `ListObjectsV2` cursor and batch deletes in chunks of 1000 (S3 cap).
 */
export async function deleteBrandingPrefix(prefix: string): Promise<number> {
  let totalDeleted = 0;
  let continuationToken: string | undefined;
  do {
    const list = await s3.send(
      new ListObjectsV2Command({
        Bucket: env.S3_BRANDING_BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    const objects = (list.Contents ?? []).map((obj) => ({ Key: obj.Key as string }));
    if (objects.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: env.S3_BRANDING_BUCKET,
          Delete: { Objects: objects, Quiet: true },
        }),
      );
      totalDeleted += objects.length;
    }
    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (continuationToken);
  return totalDeleted;
}

/**
 * Compose the public URL of a branding object. Defaults to
 * `${S3_ENDPOINT}/${S3_BRANDING_BUCKET}/${key}` so local dev (MinIO)
 * works without configuration. Production overrides via
 * `KEYCLOAK_LOGO_PUBLIC_URL_BASE` to point at the CDN.
 */
export function brandingPublicUrl(key: string): string {
  const base = env.KEYCLOAK_LOGO_PUBLIC_URL_BASE ?? `${env.S3_ENDPOINT}/${env.S3_BRANDING_BUCKET}`;
  return `${base.replace(/\/+$/, "")}/${key}`;
}

// ─── Bulk Import bucket helpers (Epic #373) ───────────────────────────
//
// **Private** bucket — every object carries PII (donor names, emails,
// addresses). Served back only through the authenticated API (see
// `GET /v1/constituents/bulk-import/:id/download`), never via presigned
// URL nor public-read. Per-tenant isolation is enforced by the key
// prefix `{org_id}/bulk-imports/{job_id}/…` (ADR-023, one bucket per
// visibility class). The bucket name is captured into
// `bulk_import_files.s3_bucket` at write time so a future env-var
// change doesn't strand old rows.

/**
 * Upload a bulk-import file (CSV / XLSX) to S3/MinIO.
 *
 * Returns the bucket name actually written to, so the caller can
 * persist it on `bulk_import_files.s3_bucket`.
 */
export async function putBulkImportObject(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<{ bucket: string }> {
  await s3.send(
    new PutObjectCommand({
      Bucket: env.S3_BULK_IMPORT_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
  return { bucket: env.S3_BULK_IMPORT_BUCKET };
}

/**
 * Fetch a bulk-import file as a Node Readable. Streamed through the
 * API by the download route so the donor-private blob never leaves
 * the server-side trust boundary.
 */
export async function getBulkImportObject(
  key: string,
): Promise<{ body: Readable; contentLength: number | undefined }> {
  const command = new GetObjectCommand({
    Bucket: env.S3_BULK_IMPORT_BUCKET,
    Key: key,
  });
  const response = await s3.send(command);
  const body = response.Body as Readable | undefined;
  if (!body) {
    throw new Error(`S3 object missing body: ${key}`);
  }
  return { body, contentLength: response.ContentLength };
}

/**
 * Fetch a bulk-import file as an in-memory Buffer. Used by the worker
 * processor to parse the file — sub-10 MB cap means the whole blob
 * comfortably fits in memory, and ExcelJS / `csv-parse/sync` both
 * want a contiguous buffer.
 */
export async function getBulkImportObjectBuffer(key: string): Promise<Buffer> {
  const { body } = await getBulkImportObject(key);
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Delete a bulk-import object — used by the cleanup compensation path
 * if the S3 upload succeeded but the DB transaction failed, and by
 * the lifecycle policy follow-up (issue #373 §6).
 */
export async function deleteBulkImportObject(key: string): Promise<void> {
  await s3.send(
    new DeleteObjectsCommand({
      Bucket: env.S3_BULK_IMPORT_BUCKET,
      Delete: { Objects: [{ Key: key }], Quiet: true },
    }),
  );
}
