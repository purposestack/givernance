/**
 * Published custom-field quotas (Epic #539 §10).
 *
 * Quotas are a product feature, not a hidden limitation: they are the
 * anti-NPSP-sprawl story and are published openly in docs/35 + pricing.
 * 422 responses name the exceeded quota. Raises beyond the platform
 * ceiling go through `customization_quota_overrides` (reason mandatory,
 * super-admin only, audited) — never through an edit here.
 *
 * Tier-name reconciliation (Epic #539 open question #1, decided in PR-1):
 * the epic's quota table is written against the PRICING tier names
 * Starter / Growth / Pro (docs/08); the code-side plan strings are
 * `starter` / `pro` / `enterprise` (see `TENANT_PLAN_VALUES`). Mapping:
 *
 *   | Epic / pricing tier | Code plan    | Fields/domain | Options/picklist | show_on_related |
 *   |---------------------|--------------|---------------|------------------|-----------------|
 *   | Starter             | `starter`    | 10            | 50               | 0               |
 *   | Growth              | `pro`        | 25            | 100              | 5               |
 *   | Pro                 | `enterprise` | 50            | 100              | 5               |
 *
 * Archived definitions never count against a quota. CSV export of custom
 * columns is available on every plan — export is NEVER plan-gated
 * (Epic #539 binding rule). Note `feature_flags.plan_gate` is not
 * implemented (docs/18): quotas are enforced in service code.
 */

import type { TenantPlan } from "../constants/tenant-plans";

export interface CustomFieldQuotas {
  /** Max non-archived definitions per (org × domain). */
  fieldsPerDomain: number;
  /** Max options (active + inactive) on one picklist / multi_picklist. */
  optionsPerPicklist: number;
  /** Max constituent definitions with `show_on_related = true` per org. */
  showOnRelatedFields: number;
}

export const CUSTOM_FIELD_QUOTAS: Record<TenantPlan, CustomFieldQuotas> = {
  starter: { fieldsPerDomain: 10, optionsPerPicklist: 50, showOnRelatedFields: 0 },
  pro: { fieldsPerDomain: 25, optionsPerPicklist: 100, showOnRelatedFields: 5 },
  enterprise: { fieldsPerDomain: 50, optionsPerPicklist: 100, showOnRelatedFields: 5 },
};

/**
 * Hard platform ceilings — a `customization_quota_overrides` row may
 * raise a tenant beyond its plan, never beyond these.
 */
export const CUSTOM_FIELD_QUOTA_CEILINGS: CustomFieldQuotas = {
  fieldsPerDomain: 50,
  optionsPerPicklist: 100,
  showOnRelatedFields: 5,
};

/**
 * Absolute cap on projected (`show_on_related`) fields, independent of
 * plan or override — the donation/campaign read models join and
 * serialize at most this many extra keys per row.
 */
export const SHOW_ON_RELATED_HARD_CAP = 5;

/**
 * `customization_quota_overrides.quota_key` values. Mirrored by the DB
 * CHECK constraint in migration 0087.
 */
export const CUSTOM_FIELD_QUOTA_KEYS = {
  FIELDS_PER_DOMAIN: "fields_per_domain",
  OPTIONS_PER_PICKLIST: "options_per_picklist",
  SHOW_ON_RELATED_FIELDS: "show_on_related_fields",
} as const;
export type CustomFieldQuotaKey =
  (typeof CUSTOM_FIELD_QUOTA_KEYS)[keyof typeof CUSTOM_FIELD_QUOTA_KEYS];

/**
 * Resolves the quota set for a stored plan string. `tenants.plan` is an
 * untyped varchar — an unknown value (bad seed, future plan mid-rollout)
 * falls back to the most restrictive tier rather than throwing.
 */
export function resolveCustomFieldQuotas(plan: string): CustomFieldQuotas {
  return CUSTOM_FIELD_QUOTAS[plan as TenantPlan] ?? CUSTOM_FIELD_QUOTAS.starter;
}

// ── Value-size limits (server-authoritative; mirrored client-side for UX) ──

export const CUSTOM_FIELD_TEXT_MAX_LENGTH = 2000;
export const CUSTOM_FIELD_LONG_TEXT_MAX_LENGTH = 10000;

// ── Definition metadata caps (mirror the varchar widths in migration 0086) ──

export const CUSTOM_FIELD_LABEL_MAX_LENGTH = 120;
export const CUSTOM_FIELD_DESCRIPTION_MAX_LENGTH = 500;
export const CUSTOM_FIELD_PURPOSE_MAX_LENGTH = 500;
export const CUSTOM_FIELD_OPTION_LABEL_MAX_LENGTH = 120;
