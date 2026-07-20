/**
 * Custom-field admin models (Epic #539) — hand-written interfaces for the
 * `/v1/custom-fields` management surface (ADR-013: no Drizzle imports; the
 * serialisable catalog shapes come from the web-safe
 * `@givernance/shared/custom-fields` subpath).
 */

import type {
  CustomFieldDefinition,
  CustomFieldDomain,
  CustomFieldOption,
  CustomFieldType,
} from "@givernance/shared/custom-fields";

export type { CustomFieldDefinition, CustomFieldDomain, CustomFieldOption, CustomFieldType };

/** Archived definition — values retained, read-only on detail + exports. */
export interface ArchivedCustomFieldDefinition extends CustomFieldDefinition {
  archivedAt: string;
}

/** Effective quotas for the caller's org (plan quotas + governed overrides). */
export interface CustomFieldQuotaInfo {
  fieldsPerDomain: number;
  optionsPerPicklist: number;
  showOnRelatedFields: number;
}

/**
 * Admin catalog for one domain. `quotas` / `catalogVersion` are nullable so
 * the page degrades gracefully if the API omits them — the quota meter then
 * shows the bare count instead of "n / limit".
 */
export interface CustomFieldCatalog {
  definitions: CustomFieldDefinition[];
  archived: ArchivedCustomFieldDefinition[];
  quotas: CustomFieldQuotaInfo | null;
  catalogVersion: string | null;
}

/**
 * Per-option usage count. `count === null` means the server masked it
 * (k-anonymity: counts under 5 render as "< 5" — the raw number never
 * reaches the browser).
 */
export interface CustomFieldOptionUsage {
  optionId: string;
  count: number | null;
}

export interface CustomFieldUsageRow {
  definitionId: string;
  key: string;
  /** Fill rate in [0, 1]; null when masked. */
  fillRate: number | null;
  /** Filled-record count; null when masked ("< 5"). */
  filledCount: number | null;
  options: CustomFieldOptionUsage[];
}

/**
 * `/v1/custom-fields/usage` flattened for one domain — per-field rows plus
 * the effective quotas (the catalog GET itself carries no quota block).
 */
export interface CustomFieldUsage {
  rows: CustomFieldUsageRow[];
  quotas: CustomFieldQuotaInfo | null;
}

export interface CustomFieldCreateInput {
  domain: CustomFieldDomain;
  key: string;
  label: string;
  description?: string | null;
  type: CustomFieldType;
  options?: CustomFieldOption[];
  required?: boolean;
  filterable?: boolean;
  exportable?: boolean;
  showOnRelated?: boolean;
  sensitive?: boolean;
  purposeText?: string | null;
}

/** PATCH body — `key` and `type` are immutable (archive + recreate). */
export interface CustomFieldUpdateInput {
  label?: string;
  description?: string | null;
  required?: boolean;
  filterable?: boolean;
  exportable?: boolean;
  showOnRelated?: boolean;
  sensitive?: boolean;
  purposeText?: string | null;
}

export interface CustomFieldOptionCreateInput {
  /** Client-generated stable id (`generateOptionId()`); server may reissue. */
  id?: string;
  label: string;
}

export interface CustomFieldOptionUpdateInput {
  label?: string;
  active?: boolean;
  sortOrder?: number;
}

/** `?dryRun=true` answer — the affected-row preview shown before merging. */
export interface OptionMergeDryRun {
  affectedCount: number;
}

/** Real merge answer (202) — backfill runs async, undo window is 30 days. */
export interface OptionMergeResult {
  /** Handle for `undoMergeOption`; also rides merged options in the catalog. */
  mergeId: string | null;
  affectedCount: number | null;
  undoExpiresAt: string | null;
}
