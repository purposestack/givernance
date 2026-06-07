/**
 * Worker-side feature flag evaluator. Mirrors the API's
 * `flag-service.ts` but reads PG directly via the worker's owner-role
 * pool — no Redis cache. Workers are stateless and check a flag at
 * most once per job; the round-trip to PG is in the noise next to the
 * SMTP send / S3 upload that follows.
 *
 * Why a worker-side copy (rather than an HTTP call into the API): the
 * worker process must not depend on the API process being up. Flag
 * evaluation is a critical-path defence-in-depth check for any gated
 * processor — if the API was down at deploy time, the worker must
 * still correctly drop disabled-feature jobs.
 *
 * Same posture as the API:
 *   - Unknown keys evaluate to `false` (doc 18 §5).
 *   - Errors are surfaced (don't silently say "enabled" on a DB
 *     failure — that's how a flagged-off feature accidentally fires).
 */

import type { FeatureFlagKey } from "@givernance/shared/constants";
import { featureFlags, tenantFlagOverrides } from "@givernance/shared/schema";
import { and, eq } from "drizzle-orm";
import { db } from "./db.js";

/**
 * `key` is the typed `FeatureFlagKey` union so a worker processor
 * cannot accidentally pass a string that doesn't exist in the
 * registry. (PR #352 Platform review Plat-LOW-8.)
 */
export async function isFlagEnabled(key: FeatureFlagKey): Promise<boolean> {
  const [row] = await db
    .select({ enabled: featureFlags.enabled })
    .from(featureFlags)
    .where(eq(featureFlags.key, key))
    .limit(1);
  return row?.enabled === true;
}

/**
 * Tenant-aware evaluation — mirrors the API's `flagService.isEnabled(key,
 * { orgId })` (flag-service.ts) so a worker check returns the SAME answer
 * the API gate returned at enqueue time. Needed for tenant-scoped flags
 * where a super-admin per-tenant override can flip an off-by-default
 * global to on (`tenant_flag_overrides.value` wins). The global-only
 * `isFlagEnabled` above would wrongly reject such a tenant.
 *
 *   - Unknown key → `false`.
 *   - `scope='platform'` → the global value, overrides ignored (same as
 *     the API). The `orgId` is accepted but unused in that branch.
 *   - `scope='tenant'` → the override row for `(orgId, key)` if present,
 *     else the global default.
 */
export async function isFlagEnabledForTenant(key: FeatureFlagKey, orgId: string): Promise<boolean> {
  const [flag] = await db
    .select({ enabled: featureFlags.enabled, scope: featureFlags.scope })
    .from(featureFlags)
    .where(eq(featureFlags.key, key))
    .limit(1);
  if (!flag) return false;
  if (flag.scope === "platform") return flag.enabled === true;

  // Owner-pool read of a platform table (`feature_flags` above + this
  // override lookup). The worker `db` is the BYPASSRLS owner pool, so the
  // explicit `eq(tenantId, orgId)` predicate IS the tenant scope — same
  // posture as the global `isFlagEnabled` read above (issue #430).
  const [override] = await db
    .select({ value: tenantFlagOverrides.value })
    .from(tenantFlagOverrides)
    .where(and(eq(tenantFlagOverrides.tenantId, orgId), eq(tenantFlagOverrides.flagKey, key)))
    .limit(1);
  if (override) return override.value === true;
  return flag.enabled === true;
}
