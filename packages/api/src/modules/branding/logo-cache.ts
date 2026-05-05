/**
 * Branding logo cache — Epic #286, API process.
 *
 * Mirrors `packages/worker/src/services/branding-logo-cache.ts` so the
 * postal-preview endpoint can embed the active logo in the on-the-fly
 * PDF without re-fetching the same `pdf-letterhead` variant from S3
 * on every request. Scope is the API process; entries TTL after 1h
 * to bound memory across long-lived API workers.
 */

import { orgBrandingAssets, tenants } from "@givernance/shared/schema";
import { eq } from "drizzle-orm";
import { LRUCache } from "lru-cache";
import { systemDb } from "../../lib/db.js";
import { getBrandingObject } from "../../lib/s3.js";

const ONE_HOUR_MS = 60 * 60 * 1000;

const cache = new LRUCache<string, Buffer>({
  max: 50,
  ttl: ONE_HOUR_MS,
  sizeCalculation: (value) => value.byteLength,
  maxSize: 50 * 1024 * 1024,
});

/**
 * Resolve and cache the `pdf-letterhead` variant for a tenant's
 * active logo. Returns null if no logo is configured / ready / on
 * disk.
 *
 * `systemDb` (BYPASSRLS) is used because the caller has already
 * authorised the org via `requireOrgAdmin`; the lookup is read-only
 * and only touches identifying columns.
 */
export async function getActivePdfLetterhead(orgId: string): Promise<Buffer | null> {
  const [tenant] = await systemDb
    .select({ logoAssetId: tenants.logoAssetId })
    .from(tenants)
    .where(eq(tenants.id, orgId));

  if (!tenant?.logoAssetId) return null;

  const cached = cache.get(tenant.logoAssetId);
  if (cached) return cached;

  const [asset] = await systemDb
    .select({
      id: orgBrandingAssets.id,
      status: orgBrandingAssets.status,
      variants: orgBrandingAssets.variants,
      deletedAt: orgBrandingAssets.deletedAt,
    })
    .from(orgBrandingAssets)
    .where(eq(orgBrandingAssets.id, tenant.logoAssetId));

  if (!asset || asset.status !== "ready" || asset.deletedAt) return null;

  const pdfVariant = asset.variants?.["pdf-letterhead"];
  if (!pdfVariant?.key) return null;

  const buffer = await getBrandingObject(pdfVariant.key);
  if (!buffer) return null;

  cache.set(tenant.logoAssetId, buffer);
  return buffer;
}

/** Test hook — clear the cache between Vitest runs. */
export function clearBrandingLogoCache(): void {
  cache.clear();
}
