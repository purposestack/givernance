/**
 * Canonical tenant plan identifiers (Epic #539 tier-name reconciliation).
 *
 * These are the ONLY plan strings that exist in code and data:
 * `tenants.plan` stores them (varchar, default `'starter'`), the
 * tenant-admin and super-admin routes accept them, and the custom-field
 * quota table (`CUSTOM_FIELD_QUOTAS`) is keyed by them.
 *
 * Marketing/pricing docs (docs/08) name the tiers Starter / Growth / Pro.
 * The code-side mapping is:
 *
 *   | Pricing tier (docs/08) | Code plan string |
 *   |------------------------|------------------|
 *   | Starter                | `starter`        |
 *   | Growth                 | `pro`            |
 *   | Pro                    | `enterprise`     |
 *
 * There is deliberately NO `growth` string — introducing one would orphan
 * every existing `tenants.plan` row and every route literal. If pricing
 * ever renames the stored identifiers, that is a data migration + API
 * contract change, not an edit here.
 */
export const TENANT_PLAN_VALUES = ["starter", "pro", "enterprise"] as const;

export type TenantPlan = (typeof TENANT_PLAN_VALUES)[number];

/** Type guard for untyped sources (DB varchar, request payloads). */
export function isTenantPlan(value: string): value is TenantPlan {
  return (TENANT_PLAN_VALUES as readonly string[]).includes(value);
}
