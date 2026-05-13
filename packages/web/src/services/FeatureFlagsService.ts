import type { ApiClient } from "@/lib/api";

/**
 * Feature-flag service — Phase 2 expansion (Epic #365 / PR #366).
 *
 * Surface summary:
 *   - Super-admin Back Office (existing Phase-1 endpoints, now with
 *     `overrideStats` + `scope` + `public` fields on the row).
 *   - Super-admin tenant detail (NEW) — list every flag for a tenant
 *     + upsert / remove overrides per flag.
 *   - Org-admin self-service (NEW) — list / patch a flag the operator
 *     is permitted to control on their own org (filtered server-side
 *     to `scope='tenant' AND tenant_override_allowed=true`).
 *   - Tenant-readable projection (existing, now filtered by
 *     `public=true` server-side).
 */

export interface FeatureFlagRow {
  key: string;
  enabled: boolean;
  /** Short, friendly heading (e.g. "Bulk emails to constituents"). */
  label: string;
  /** One or two sentences in plain language explaining what the feature does. */
  description: string;
  scope: "platform" | "tenant";
  tenantOverrideAllowed: boolean;
  public: boolean;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Tenant-override counts (super-admin only, present when the
   * Phase-2 self-flag is on). `null` otherwise so the JSON shape stays
   * stable across flag flips and the UI can branch on null vs object.
   */
  overrideStats: { enabledCount: number; disabledCount: number } | null;
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
 * metadata. Phase 2: filtered server-side by `public=true`.
 */
export interface PublicFeatureFlag {
  key: string;
  enabled: boolean;
}

interface PublicListResponse {
  data: PublicFeatureFlag[];
}

/**
 * Override row as returned by the super-admin / org-admin endpoints.
 * `setBy` is the operator's users.id when available (always null for
 * super-admin actions because platform admins live in
 * `platform_admins`, not `users`).
 */
export interface TenantFlagOverrideRow {
  tenantId: string;
  flagKey: string;
  value: boolean;
  reason: string | null;
  setBy: string | null;
  setAt: string;
}

/**
 * Per-tenant flag view — what the super-admin tenant-detail tab and
 * the org-admin self-service page render. Carries the platform
 * default, the effective value for the tenant, and the override row
 * if present. The frontend uses `override === null` to decide
 * between "Override" / "Clear override" actions.
 */
export interface TenantFlagViewRow {
  key: string;
  label: string;
  description: string;
  scope: "platform" | "tenant";
  tenantOverrideAllowed: boolean;
  public: boolean;
  platformDefault: boolean;
  effectiveValue: boolean;
  override: TenantFlagOverrideRow | null;
}

interface TenantFlagViewListResponse {
  data: TenantFlagViewRow[];
}

interface OverrideUpsertResponse {
  data: TenantFlagOverrideRow;
}

/**
 * One row of the "tenants per flag" listing — drives the
 * `/admin/feature-flags/[key]` per-flag tenant management page.
 * `effectiveValue` reflects the evaluator's actual answer for this
 * tenant (override if set, else platform default).
 */
export interface FlagTenantRow {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  override: TenantFlagOverrideRow | null;
  effectiveValue: boolean;
}

interface FlagTenantListResponse {
  data: FlagTenantRow[];
}

export const FeatureFlagsService = {
  /** Super-admin global list — drives the Back Office page. */
  async list(client: ApiClient): Promise<FeatureFlagRow[]> {
    const response = await client.get<ListResponse>("/v1/admin/feature-flags");
    return response.data;
  },

  /**
   * Tenant-readable list. Returns just `{ key, enabled }` for every
   * flag where `public=true`, with the caller's tenant overrides
   * overlaid on the value. Safe to call from any authenticated caller.
   */
  async listPublic(client: ApiClient): Promise<PublicFeatureFlag[]> {
    const response = await client.get<PublicListResponse>("/v1/feature-flags");
    return response.data;
  },

  /** Super-admin: flip the platform default of a single flag. */
  async setEnabled(client: ApiClient, key: string, enabled: boolean): Promise<FeatureFlagRow> {
    const response = await client.patch<PatchResponse>(
      `/v1/admin/feature-flags/${encodeURIComponent(key)}`,
      { enabled },
    );
    return response.data;
  },

  /**
   * Super-admin: list every active tenant + their current state for
   * one flag (drives the `/admin/feature-flags/[key]` page). Includes
   * tenants without an override (they render at the platform default).
   */
  async listTenantsForFlag(client: ApiClient, flagKey: string): Promise<FlagTenantRow[]> {
    const response = await client.get<FlagTenantListResponse>(
      `/v1/admin/feature-flags/${encodeURIComponent(flagKey)}/tenants`,
    );
    return response.data;
  },

  /** Super-admin: list every flag for one tenant (drives the tenant-detail tab). */
  async listForTenant(client: ApiClient, tenantId: string): Promise<TenantFlagViewRow[]> {
    const response = await client.get<TenantFlagViewListResponse>(
      `/v1/admin/tenants/${encodeURIComponent(tenantId)}/feature-flags`,
    );
    return response.data;
  },

  /** Super-admin: upsert an override (PUT semantics — idempotent). */
  async setTenantOverride(
    client: ApiClient,
    tenantId: string,
    flagKey: string,
    body: { value: boolean; reason?: string | null },
  ): Promise<TenantFlagOverrideRow> {
    const response = await client.put<OverrideUpsertResponse>(
      `/v1/admin/tenants/${encodeURIComponent(tenantId)}/feature-flags/${encodeURIComponent(flagKey)}`,
      body,
    );
    return response.data;
  },

  /** Super-admin: remove an override (revert to platform default). */
  async deleteTenantOverride(client: ApiClient, tenantId: string, flagKey: string): Promise<void> {
    await client.delete(
      `/v1/admin/tenants/${encodeURIComponent(tenantId)}/feature-flags/${encodeURIComponent(flagKey)}`,
    );
  },

  /**
   * Org-admin self-service: list every flag this caller is permitted
   * to toggle on their own org. Server filters to `scope='tenant' AND
   * tenant_override_allowed=true`. Returns an empty array on day one
   * — the UI renders an explanatory empty state.
   */
  async listForOrgAdmin(client: ApiClient): Promise<TenantFlagViewRow[]> {
    const response = await client.get<TenantFlagViewListResponse>("/v1/org/feature-flags");
    return response.data;
  },

  /** Org-admin: upsert an override for the caller's own org. */
  async setOrgOverride(
    client: ApiClient,
    flagKey: string,
    body: { value: boolean; reason?: string | null },
  ): Promise<TenantFlagOverrideRow> {
    const response = await client.patch<OverrideUpsertResponse>(
      `/v1/org/feature-flags/${encodeURIComponent(flagKey)}`,
      body,
    );
    return response.data;
  },

  /**
   * Org-admin: remove the caller's own override (revert to platform
   * default). Cleaner than the prior PATCH-as-delete emulation: the
   * override row is genuinely gone, the audit log records a
   * `feature_flag.override_removed` event, and a subsequent reload
   * returns `override: null` instead of an override-equal-to-default
   * row that the FE has to special-case.
   */
  async deleteOrgOverride(client: ApiClient, flagKey: string): Promise<void> {
    await client.delete(`/v1/org/feature-flags/${encodeURIComponent(flagKey)}`);
  },
};

/**
 * Helper: O(1) lookup of a flag value from a list. Returns `false` on
 * unknown key (matches the API + worker posture in doc 18 §5).
 */
export function isFlagEnabled(flags: PublicFeatureFlag[], key: string): boolean {
  return flags.find((flag) => flag.key === key)?.enabled === true;
}
