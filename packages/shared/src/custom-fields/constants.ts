/**
 * Cross-package wiring constants for the customization engine
 * (Epic #539). Queue/job names live here (not in `jobs/index.ts`) so
 * the web package can import this directory without pulling the
 * backend job type definitions.
 */

import type { CustomFieldDomain } from "./types";

/**
 * Redis cache key prefix for the per-(org × domain) active-definition
 * catalog. Full key: `customfields:{orgId}:{domain}`. TTL is 60 s —
 * deliberately ≤ 1 minute so no operator-facing flush route is required
 * (issue #449) — plus explicit `unlink` on every definition mutation.
 */
export const CUSTOM_FIELDS_CACHE_PREFIX = "customfields:";

export function customFieldsCacheKey(orgId: string, domain: CustomFieldDomain): string {
  return `${CUSTOM_FIELDS_CACHE_PREFIX}${orgId}:${domain}`;
}

/** Cache TTL for the active-definition catalog (seconds). */
export const CUSTOM_FIELDS_CACHE_TTL_SECONDS = 60;

/**
 * BullMQ queue for customization background work: option-merge backfill
 * jobs (chunked, idempotent, audited) and the daily merge-undo purge
 * cron. Snake_case to match the `QUEUE_NAMES` convention in
 * `jobs/index.ts`; the worker registers it alongside the others.
 */
export const CUSTOM_FIELDS_QUEUE = "custom_fields";

/** Job names within `CUSTOM_FIELDS_QUEUE`. */
export const CUSTOM_FIELD_JOBS = {
  /**
   * Rewrites stored picklist values from a merged option id to its
   * survivor, chunk by chunk, writing `custom_field_merge_undo` rows
   * before each rewrite. Deterministic jobId = `option-merge-{mergeId}`.
   */
  OPTION_MERGE_BACKFILL: "custom-field-option-merge-backfill",
  /**
   * Restores pre-merge values from `custom_field_merge_undo` rows and
   * deletes them as it goes (retry-safe). Deterministic jobId =
   * `option-merge-undo-{mergeId}`.
   */
  OPTION_MERGE_UNDO_BACKFILL: "custom-field-option-merge-undo-backfill",
  /** Daily cron deleting `custom_field_merge_undo` rows past `expires_at`. */
  MERGE_UNDO_PURGE: "custom-field-merge-undo-purge",
} as const;
export type CustomFieldJobName = (typeof CUSTOM_FIELD_JOBS)[keyof typeof CUSTOM_FIELD_JOBS];

/**
 * Undo-window length for option/tag merges. `custom_field_merge_undo`
 * rows are written with `expires_at = now() + 30 days` and purged by
 * the cron — merge reversibility lives there, never as per-row value
 * snapshots in long-retention `audit_logs` (Epic #539 anti-goal #7).
 */
export const CUSTOM_FIELD_MERGE_UNDO_TTL_DAYS = 30;

/**
 * Bulk-import template version once per-tenant custom columns are
 * appended (docs/28). `bulk_import_jobs.template_version` bumps from
 * '1.0' to this when the constituent-domain flag is on for the tenant.
 */
export const CUSTOM_FIELDS_IMPORT_TEMPLATE_VERSION = "1.1";

/**
 * Stable header alias prefix for custom columns in the bulk-import
 * template: the human-readable header is the definition label, the
 * machine-stable alias is `cf_<key>`. The prefix is reserved in
 * `RESERVED_KEY_PREFIXES` so a definition key can never collide.
 */
export const CUSTOM_FIELDS_IMPORT_HEADER_PREFIX = "cf_";
