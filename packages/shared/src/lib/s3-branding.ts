/**
 * Branding-bucket S3 helpers — Epic #286 (shared, issue #480).
 *
 * One implementation of the branding-asset object-storage helpers,
 * **infra-agnostic via dependency injection**: every function receives
 * the caller's own `S3Client` (and the resolved bucket name / public-URL
 * inputs) as parameters instead of importing `env` or a module-level
 * client. The API and the worker each pre-bind their own client + env
 * in a thin wrapper (`packages/{api,worker}/src/lib/s3.ts`) and delegate
 * here — so there is ONE branding implementation, no drift, and this
 * module stays unit-testable without an env/`S3Client` singleton.
 *
 * Reachable ONLY via the `@givernance/shared/lib/s3-branding` subpath —
 * deliberately NOT re-exported from the root barrel (`src/index.ts`),
 * which reaches the web package. Keeping the `@aws-sdk/client-s3`
 * surface out of the root barrel avoids an ADR-013 frontend-boundary
 * leak (heavy server-only dep).
 *
 * The branding bucket is **public-read** at the bucket level so donor-
 * facing surfaces (Keycloak login template, donation page) can hit
 * object URLs directly with `Cache-Control: public, max-age=31536000,
 * immutable`. The keys themselves are content-addressed
 * (`{org_id}/logo/{logo_id}/{variant}.{ext}`) so a stale CDN edge can
 * never leak a logo across logo versions.
 *
 * IMPORTANT — defense-in-depth:
 *   - We do NOT set `ACL: private` on these uploads (would override the
 *     bucket-level policy and 403 the donor).
 *   - We do NOT set SSE — encryption-at-rest is enabled at the bucket
 *     level (Scaleway default + SeaweedFS via the `WEED_S3_SSE_KEY` KEK,
 *     ADR-034); a per-object override would force a key dance for a value
 *     that is, by design, public.
 */

import type { Readable } from "node:stream";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";

/**
 * Upload a branding asset (original or derived variant) to the public-
 * read branding bucket. The Cache-Control + Content-Type are baked in
 * here so every upload site stays consistent. Returns the key.
 */
export async function putBrandingObject(
  s3: S3Client,
  bucket: string,
  key: string,
  body: Buffer,
  contentType: string,
): Promise<string> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
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
 * handler to embed the active logo in the on-the-fly PDF preview, and by
 * the worker rasterisation pipeline). Returns `null` on 404 so callers
 * can degrade gracefully.
 */
export async function getBrandingObject(
  s3: S3Client,
  bucket: string,
  key: string,
): Promise<Buffer | null> {
  try {
    const out = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
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
export async function deleteBrandingPrefix(
  s3: S3Client,
  bucket: string,
  prefix: string,
): Promise<number> {
  let totalDeleted = 0;
  let continuationToken: string | undefined;
  do {
    const list = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    const objects = (list.Contents ?? []).map((obj) => ({ Key: obj.Key as string }));
    if (objects.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
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
 * List the top-level `{org_id}/` prefixes of the branding bucket.
 * Used by the nightly orphan-GC sweep (issue #291) to find prefixes
 * whose parent tenant no longer exists (hard-deleted tenant whose
 * `org_branding_assets` cascade beat the per-asset GC job). Uses the
 * S3 `Delimiter` grouping so one paginated LIST returns one entry per
 * org regardless of how many objects each org holds.
 */
export async function listBrandingTopLevelPrefixes(
  s3: S3Client,
  bucket: string,
): Promise<string[]> {
  const prefixes: string[] = [];
  let continuationToken: string | undefined;
  do {
    const list = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Delimiter: "/",
        ContinuationToken: continuationToken,
      }),
    );
    for (const cp of list.CommonPrefixes ?? []) {
      if (cp.Prefix) prefixes.push(cp.Prefix);
    }
    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (continuationToken);
  return prefixes;
}

/**
 * Newest `LastModified` among the objects under a prefix, or null when
 * the prefix is empty. The orphan-GC sweep uses this as the grace-period
 * clock for prefixes that have no DB row left to date them by: a prefix
 * is only reaped once its newest object is older than the grace window.
 */
export async function newestBrandingObjectMtime(
  s3: S3Client,
  bucket: string,
  prefix: string,
): Promise<Date | null> {
  let newest: Date | null = null;
  let continuationToken: string | undefined;
  do {
    const list = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of list.Contents ?? []) {
      if (obj.LastModified && (!newest || obj.LastModified > newest)) {
        newest = obj.LastModified;
      }
    }
    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (continuationToken);
  return newest;
}

/**
 * Compose the public URL of a branding object. Defaults to
 * `${endpoint}/${brandingBucket}/${key}` so local dev (SeaweedFS, ADR-034)
 * works without configuration. Production overrides via `publicUrlBase`
 * (sourced from `KEYCLOAK_LOGO_PUBLIC_URL_BASE`) to point at the CDN.
 */
export function brandingPublicUrl(
  key: string,
  opts: { endpoint: string; brandingBucket: string; publicUrlBase?: string },
): string {
  const base = opts.publicUrlBase ?? `${opts.endpoint}/${opts.brandingBucket}`;
  return `${base.replace(/\/+$/, "")}/${key}`;
}
