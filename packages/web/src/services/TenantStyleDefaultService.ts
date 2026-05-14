import type { ApiClient } from "@/lib/api";
import type {
  PublicPageStyle,
  TenantStyleDefault,
  TenantStyleDefaultResponse,
} from "@/models/public-page-style";

/**
 * Service for the org-level default archetype on the public donation
 * page (Epic #362). Two routes, both flag-gated:
 *
 *   GET   /v1/org/style-default — read current value (null = inherits)
 *   PATCH /v1/org/style-default — write a new value (or null to clear)
 *
 * Both routes return 404 when `donation.public_page_styles` is off
 * for the caller's tenant. The settings page SSR-checks the flag
 * before mounting the picker, so the 404 is the cleanup-of-last-
 * resort if a stale browser tab makes a call after the flag flips
 * off mid-session.
 */
export const TenantStyleDefaultService = {
  async getDefault(client: ApiClient): Promise<TenantStyleDefault> {
    const response = await client.get<TenantStyleDefaultResponse>("/v1/org/style-default");
    return response.data;
  },

  async setDefault(
    client: ApiClient,
    defaultPublicPageStyle: PublicPageStyle | null,
  ): Promise<TenantStyleDefault> {
    const response = await client.patch<TenantStyleDefaultResponse>("/v1/org/style-default", {
      defaultPublicPageStyle,
    });
    return response.data;
  },
};
