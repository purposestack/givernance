import type { ApiClient } from "@/lib/api";

/**
 * Back-office service for the platform-wide feature-flag registry
 * (PR #352 follow-up; see `docs/18-feature-flags.md`).
 *
 * Read endpoint is super-admin-gated (404 to anyone else). The page
 * fetches once server-side via `createServerApiClient` and renders
 * a toggle UI; per-row PATCH calls flow through the browser client.
 */

export interface FeatureFlagRow {
  key: string;
  enabled: boolean;
  description: string;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ListResponse {
  data: FeatureFlagRow[];
}

interface PatchResponse {
  data: FeatureFlagRow;
}

/**
 * Tenant-facing projection — just `{ key, enabled }`. Returned by the
 * non-super-admin `/v1/feature-flags` GET so tenant pages can decide
 * whether to render a gated UI surface without seeing the admin
 * metadata (description, updatedBy).
 */
export interface PublicFeatureFlag {
  key: string;
  enabled: boolean;
}

interface PublicListResponse {
  data: PublicFeatureFlag[];
}

export const FeatureFlagsService = {
  /** Super-admin list — drives the Back Office page. */
  async list(client: ApiClient): Promise<FeatureFlagRow[]> {
    const response = await client.get<ListResponse>("/v1/admin/feature-flags");
    return response.data;
  },

  /**
   * Tenant-readable list. Returns just `{ key, enabled }` for every
   * flag. Used by tenant pages to hide gated UI surfaces SSR-side.
   * Safe to call from any authenticated caller.
   */
  async listPublic(client: ApiClient): Promise<PublicFeatureFlag[]> {
    const response = await client.get<PublicListResponse>("/v1/feature-flags");
    return response.data;
  },

  async setEnabled(client: ApiClient, key: string, enabled: boolean): Promise<FeatureFlagRow> {
    const response = await client.patch<PatchResponse>(
      `/v1/admin/feature-flags/${encodeURIComponent(key)}`,
      { enabled },
    );
    return response.data;
  },
};

/**
 * Helper: O(1) lookup of a flag value from a list. Returns `false` on
 * unknown key (matches the API + worker posture in doc 18 §5).
 */
export function isFlagEnabled(flags: PublicFeatureFlag[], key: string): boolean {
  return flags.find((flag) => flag.key === key)?.enabled === true;
}
