/**
 * Branding logo cache — Epic #286, API process.
 *
 * Mirrors `packages/worker/src/services/branding-logo-cache.ts` so the
 * postal-preview endpoint can embed the active logo in the on-the-fly
 * PDF without re-fetching the same `pdf-letterhead` variant from S3
 * on every request. Scope is the API process; entries TTL after 1h
 * to bound memory across long-lived API workers.
 *
 * The LRU shape itself lives in `@givernance/shared/lib/lru-fetch-cache`
 * (issue #294); this module owns only the API-specific resolution +
 * fetch closure.
 */

import { createLruFetchCache } from "@givernance/shared/lib/lru-fetch-cache";
import { orgBrandingAssets, tenants } from "@givernance/shared/schema";
import { and, eq } from "drizzle-orm";
import { systemDb } from "../../lib/db.js";
import { getBrandingObject } from "../../lib/s3.js";

const cache = createLruFetchCache();

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

  return cache.get(tenant.logoAssetId, async (assetId) => {
    // Issue #430 — scope the asset lookup by orgId even though we use
    // `systemDb` (owner pool, BYPASSRLS). The tenant pointer
    // `tenants.logo_asset_id` should never reference a foreign tenant's
    // asset, but a drifted/corrupted pointer would otherwise embed the
    // wrong logo in receipt PDFs. The explicit predicate keeps the
    // tenant boundary load-bearing on the application code.
    const [asset] = await systemDb
      .select({
        id: orgBrandingAssets.id,
        status: orgBrandingAssets.status,
        variants: orgBrandingAssets.variants,
        deletedAt: orgBrandingAssets.deletedAt,
      })
      .from(orgBrandingAssets)
      .where(and(eq(orgBrandingAssets.id, assetId), eq(orgBrandingAssets.orgId, orgId)));

    if (asset?.status !== "ready" || asset.deletedAt) return null;

    const pdfVariant = asset.variants?.["pdf-letterhead"];
    if (!pdfVariant?.key) return null;

    return getBrandingObject(pdfVariant.key);
  });
}

/** Test hook — clear the cache between Vitest runs. */
export function clearBrandingLogoCache(): void {
  cache.clear();
}
