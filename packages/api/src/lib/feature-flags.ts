/**
 * Minimal feature-flag resolver (issue #62 / preview of doc-18).
 *
 * Flags are stored as a JSONB column on `tenants.feature_flags`, keyed by
 * the flag id (e.g. `"ff.payments.mollie": true`). Missing keys resolve to
 * `false` so the column can stay sparse — only tenants that flipped a
 * flag carry an entry. The full doc-18 system layers a Redis cache + a
 * `tenant_flag_overrides` table on top of this, but #62 only needs to
 * gate Mollie and we keep the surface minimal.
 *
 * Why a separate file (vs. inlined into the factory): the helper is also
 * used by the org-admin Settings PATCH route to refuse switching to
 * `payment_gateway = 'mollie'` when the flag is off. Keeping the resolver
 * call site small and centralised makes it easy to swap in the Redis-backed
 * resolver later without re-finding consumers.
 */

import type { FEATURE_FLAG_KEYS, FeatureFlagKey, tenants } from "@givernance/shared/schema";
import type { InferSelectModel } from "drizzle-orm";

type TenantRow = InferSelectModel<typeof tenants>;

/** Subset of `tenants` row the resolver needs. */
export type FeatureFlagTenant = Pick<TenantRow, "featureFlags">;

/**
 * Resolve a single feature flag for a tenant. Returns `false` when the key
 * is missing from the JSONB column or its value is not strictly `true`.
 *
 * The strict `=== true` check defends against a JSONB row that ended up
 * with `{"ff.payments.mollie": "true"}` (string) — that should NOT
 * activate the gateway by accident. Only the explicit boolean unlocks it.
 */
export function hasFeatureFlag(tenant: FeatureFlagTenant, key: FeatureFlagKey): boolean {
  const flags = tenant.featureFlags ?? {};
  return flags[key] === true;
}

/**
 * Type guard so the Settings PATCH route can validate the body without
 * pulling the full doc-18 registry of allowed flag keys. Re-exported from
 * `@givernance/shared/schema` so consumers don't import the runtime list
 * (`FEATURE_FLAG_KEYS`) just to reach the type.
 */
export function isFeatureFlagKey(
  candidate: string,
  registry: typeof FEATURE_FLAG_KEYS,
): candidate is FeatureFlagKey {
  return (registry as readonly string[]).includes(candidate);
}
