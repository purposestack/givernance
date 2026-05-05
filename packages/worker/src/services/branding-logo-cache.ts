/**
 * Branding logo cache — Epic #286.
 *
 * Postal-export jobs render up to a few thousand PDFs per export, all
 * for the same tenant. Fetching the same `pdf-letterhead` variant from
 * S3 once per recipient is wasteful — we hit ms-class latency once per
 * letter on a job that's already CPU-bound on PDFKit. This LRU caches
 * the buffer per `assetId` so the second-onward fetches are in-process.
 *
 * Cache scope: per worker process. A typical export pegs one process
 * for its full duration, so even a tiny LRU (50 entries) covers
 * "current export's logo" hot path with overhead in the tens of
 * kilobytes (PNG variants are ~30–80 KB).
 *
 * TTL: 1h. The asset is content-addressed in S3, so an in-flight
 * export will never see a "different logo" mid-run; the TTL just keeps
 * memory bounded across long-lived workers that process many tenants.
 */

import { orgBrandingAssets, tenants } from "@givernance/shared/schema";
import { eq } from "drizzle-orm";
import { LRUCache } from "lru-cache";
import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { getBrandingObject } from "../lib/s3.js";

const ONE_HOUR_MS = 60 * 60 * 1000;

const cache = new LRUCache<string, Buffer>({
  max: 50,
  ttl: ONE_HOUR_MS,
  // Roughly bound per-entry size to ~1 MB — defends against a
  // misconfigured pipeline shipping a giant PDF letterhead variant.
  sizeCalculation: (value) => value.byteLength,
  maxSize: 50 * 1024 * 1024,
});

/**
 * Resolve and cache the `pdf-letterhead` variant buffer for a tenant's
 * active logo. Returns null if the tenant has no logo configured, the
 * asset is not yet ready, or the variant blob is missing in S3.
 *
 * Cheap on cache hit — hits the DB only once per `(tenantId, assetId)`
 * pair within the TTL window.
 */
export async function getActivePdfLetterhead(orgId: string): Promise<Buffer | null> {
  // Resolve the active asset id first — not cached, because the
  // `tenants.logo_asset_id` pointer can flip mid-worker-process when
  // the operator activates a new logo. This DB hit is sub-ms.
  const [tenant] = await db
    .select({ logoAssetId: tenants.logoAssetId })
    .from(tenants)
    .where(eq(tenants.id, orgId));

  if (!tenant?.logoAssetId) return null;

  const cached = cache.get(tenant.logoAssetId);
  if (cached) return cached;

  const [asset] = await db
    .select({
      id: orgBrandingAssets.id,
      status: orgBrandingAssets.status,
      variants: orgBrandingAssets.variants,
      deletedAt: orgBrandingAssets.deletedAt,
    })
    .from(orgBrandingAssets)
    .where(eq(orgBrandingAssets.id, tenant.logoAssetId));

  if (!asset || asset.status !== "ready" || asset.deletedAt) {
    return null;
  }

  const pdfVariant = asset.variants?.["pdf-letterhead"];
  if (!pdfVariant?.key) {
    logger.warn(
      { assetId: asset.id },
      "Active logo missing pdf-letterhead variant — skipping logo embed",
    );
    return null;
  }

  const buffer = await getBrandingObject(pdfVariant.key);
  if (!buffer) {
    logger.warn(
      { assetId: asset.id, key: pdfVariant.key },
      "Active logo pdf-letterhead variant missing in S3 — skipping logo embed",
    );
    return null;
  }

  cache.set(tenant.logoAssetId, buffer);
  return buffer;
}

/** Test hook — clear the cache between Vitest runs. */
export function clearBrandingLogoCache(): void {
  cache.clear();
}
