/** S3 client for uploading generated files (streaming; SeaweedFS self-hosted / Scaleway prod) */

import type { Readable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import {
  brandingPublicUrl as brandingPublicUrlShared,
  deleteBrandingPrefix as deleteBrandingPrefixShared,
  getBrandingObject as getBrandingObjectShared,
  listBrandingTopLevelPrefixes as listBrandingTopLevelPrefixesShared,
  newestBrandingObjectMtime as newestBrandingObjectMtimeShared,
  putBrandingObject as putBrandingObjectShared,
} from "@givernance/shared/lib/s3-branding";
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
      // Belt-and-suspenders: bucket defaults are private on both Scaleway
      // Object Storage and our SeaweedFS setup, but an object-level ACL guarantees
      // that a future bucket-policy mistake (e.g. public-read ACL at bucket
      // scope) cannot accidentally expose tax receipts or campaign letters.
      ACL: "private",
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

/**
 * Stream an arbitrary binary payload (typically a ZIP archive) to S3 — used
 * by the postal-export worker to upload the bundled archive once all per-
 * recipient PDFs have been streamed through `archiver` (Epic #274).
 *
 * `Body` is typed as a Node Readable to match `archiver`'s output; the
 * underlying multipart upload handles any `Readable` the AWS SDK accepts.
 */
export async function streamArchiveToS3(
  bucket: string,
  key: string,
  doc: NodeJS.ReadableStream,
  contentType = "application/zip",
): Promise<string> {
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: bucket,
      Key: key,
      Body: doc as unknown as Readable,
      ContentType: contentType,
      ServerSideEncryption: "AES256",
      ACL: "private",
    },
  });
  await upload.done();
  return key;
}

/**
 * Upload a platform monthly finance report PDF (issue #443) to the
 * private reports bucket. Key shape: `monthly/{YYYY-MM}/{reportId}.pdf`
 * — no tenant prefix because the report aggregates platform-wide
 * cross-tenant data and is consumed by super-admins only.
 */
export async function uploadPlatformReportPdf(
  month: string,
  reportId: string,
  doc: NodeJS.ReadableStream,
): Promise<string> {
  const key = `monthly/${month}/${reportId}.pdf`;
  return streamPdfToS3(env.S3_REPORTS_BUCKET, key, doc);
}

/** Upload a postal-export ZIP to the campaigns bucket. */
export async function uploadCampaignZip(
  tenantId: string,
  campaignId: string,
  exportId: string,
  doc: NodeJS.ReadableStream,
): Promise<string> {
  const key = `${tenantId}/campaigns/${campaignId}/exports/${exportId}.zip`;
  return streamArchiveToS3(env.S3_CAMPAIGNS_BUCKET, key, doc);
}

/**
 * Upload a postal-export merged PDF to the campaigns bucket (project item
 * #194221573). The deterministic `.pdf` key mirrors the `.zip` idempotency
 * contract — a BullMQ retry overwrites the previous (incomplete) object.
 * The whole document is a single Buffer (pdf-lib has no streaming save),
 * uploaded in one PutObject via `lib-storage`'s `Upload`.
 */
export async function uploadCampaignMergedPdf(
  tenantId: string,
  campaignId: string,
  exportId: string,
  pdf: Buffer,
): Promise<string> {
  const key = `${tenantId}/campaigns/${campaignId}/exports/${exportId}.pdf`;
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: env.S3_CAMPAIGNS_BUCKET,
      Key: key,
      Body: pdf,
      ContentType: "application/pdf",
      ServerSideEncryption: "AES256",
      ACL: "private",
    },
  });
  await upload.done();
  return key;
}

// ─── Branding bucket helpers (Epic #286) ───────────────────────────────────
//
// The branding-asset implementations live in the shared package
// (`@givernance/shared/lib/s3-branding`, issue #480) so the worker and the
// API share ONE copy. The wrappers below pre-bind this package's own `s3`
// client + `env` bucket/URL config so every existing call site keeps its
// original signature unchanged. See the shared module for the full
// public-read / content-addressed-key / no-per-object-ACL rationale.

/**
 * Upload a branding asset (original or derived variant) to the public-
 * read branding bucket. Returns the key.
 */
export function putBrandingObject(key: string, body: Buffer, contentType: string): Promise<string> {
  return putBrandingObjectShared(s3, env.S3_BRANDING_BUCKET, key, body, contentType);
}

/** Fetch a branding object as a Buffer. Returns null on 404. */
export function getBrandingObject(key: string): Promise<Buffer | null> {
  return getBrandingObjectShared(s3, env.S3_BRANDING_BUCKET, key);
}

/**
 * Delete every object under a prefix. Used by the `branding.gc_asset`
 * worker job to clean up after a soft-deleted asset.
 */
export function deleteBrandingPrefix(prefix: string): Promise<number> {
  return deleteBrandingPrefixShared(s3, env.S3_BRANDING_BUCKET, prefix);
}

/**
 * List the top-level `{org_id}/` prefixes of the branding bucket.
 * Used by the nightly orphan-GC sweep (issue #291).
 */
export function listBrandingTopLevelPrefixes(): Promise<string[]> {
  return listBrandingTopLevelPrefixesShared(s3, env.S3_BRANDING_BUCKET);
}

/**
 * Newest object mtime under a branding prefix (null when empty) — the
 * orphan-GC sweep's grace clock for prefixes with no DB row.
 */
export function newestBrandingObjectMtime(prefix: string): Promise<Date | null> {
  return newestBrandingObjectMtimeShared(s3, env.S3_BRANDING_BUCKET, prefix);
}

/** Compose the public URL of a branding object. */
export function brandingPublicUrl(key: string): string {
  return brandingPublicUrlShared(key, {
    endpoint: env.S3_ENDPOINT,
    brandingBucket: env.S3_BRANDING_BUCKET,
    publicUrlBase: env.KEYCLOAK_LOGO_PUBLIC_URL_BASE,
  });
}
