/** S3/MinIO client for uploading generated files (supports streaming) */

import type { Readable } from "node:stream";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
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
      // Belt-and-suspenders: bucket defaults are private on both Scaleway
      // Object Storage and our MinIO setup, but an object-level ACL guarantees
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

// ─── Branding bucket helpers (Epic #286) ───────────────────────────────────
//
// See `packages/api/src/lib/s3.ts` for the full rationale (public-read
// bucket, content-addressed keys, no per-object ACL/SSE override).

/**
 * Upload a branding asset (original or derived variant) to the public-
 * read branding bucket. Sets the long-lived immutable cache header
 * because keys are content-addressed.
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
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );
  return key;
}

/** Fetch a branding object as a Buffer. Returns null on 404. */
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
 * worker job to clean up after a soft-deleted asset.
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

/** Compose the public URL of a branding object. */
export function brandingPublicUrl(key: string): string {
  const base = env.KEYCLOAK_LOGO_PUBLIC_URL_BASE ?? `${env.S3_ENDPOINT}/${env.S3_BRANDING_BUCKET}`;
  return `${base.replace(/\/+$/, "")}/${key}`;
}
