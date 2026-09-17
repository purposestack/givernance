/**
 * Public donation page cache key + single-campaign invalidation.
 *
 * Lives in its own module so writers outside the public service (e.g. the
 * campaign status transitions in `campaigns/service.ts`, issue #611) can bust
 * the entry without importing the Stripe-dependent public service.
 */

import { redis } from "../../lib/redis.js";

export const PUBLIC_PAGE_CACHE_PREFIX = "public-page:v1:";

/** Drop the cached donor-facing payload (or cached 404) for one campaign. */
export async function invalidatePublicPageCache(campaignId: string): Promise<void> {
  await redis.del(`${PUBLIC_PAGE_CACHE_PREFIX}${campaignId}`);
}
