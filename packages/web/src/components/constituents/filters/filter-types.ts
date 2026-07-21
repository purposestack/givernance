/**
 * Advanced filter type definitions for constituent segmentation.
 */

/**
 * Operator vocabulary — kept in exact lockstep with the BE `FilterOperator`
 * union (`packages/api/src/modules/constituents/filters/types.ts`) and the
 * TypeBox `FilterOperatorSchema` on the wire (`filter.routes.ts`). Any operator
 * the FE emits that the BE doesn't list is rejected with a 400 before the query
 * runs, so this union must never drift.
 *
 * Nullable presence is expressed with `isNull` / `isNotNull` (BE names),
 * surfaced to operators as "is empty" / "has a value". The earlier FE-only
 * `exists` / `notExists` names never matched the BE and always 400'd; likewise
 * `notIn` / `notContains` had no BE mapping and were removed.
 */
export type FilterOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between"
  | "in"
  | "contains"
  | "startsWith"
  | "endsWith"
  // Array-column operators (issue #465). `constituent.type` / `constituent.tags`
  // are `text[]`; these map to Drizzle `arrayContains` (all-of) /
  // `arrayOverlaps` (any-of) BE-side.
  | "arrayContains"
  | "arrayOverlaps"
  // Presence checks on nullable columns. Value-less — the value input is hidden
  // and these are treated as "complete" everywhere a condition is validated.
  | "isNull"
  | "isNotNull";

/**
 * Operators that take NO value (presence checks). Rendered without a value
 * input and always considered "complete". Referenced everywhere instead of
 * inline string equality so a future value-less operator is a one-line change.
 */
export const NULLARY_OPERATORS: ReadonlySet<FilterOperator> = new Set<FilterOperator>([
  "isNull",
  "isNotNull",
]);

/** True when the operator takes no value (isNull / isNotNull). */
export function isNullaryOperator(operator: FilterOperator): boolean {
  return NULLARY_OPERATORS.has(operator);
}

export type LogicalOperator = "AND" | "OR";

export type FilterFieldType = "text" | "number" | "date" | "select" | "multiselect" | "boolean";

// Type for filter values based on field type
export type FilterValue =
  | string
  | number
  | boolean
  | string[]
  | number[]
  | [string, string]
  | [number, number]
  | null;

export interface FilterCondition {
  id: string;
  field: string;
  operator: FilterOperator;
  value: FilterValue;
  // For nested conditions
  subConditions?: FilterQuery;
}

export interface FilterQuery {
  // Optional id used by nested groups in tests/utilities
  id?: string;
  operator: LogicalOperator;
  conditions: Array<FilterCondition | FilterQuery>;
  // Pre-defined pattern detection
  patterns?: FilterPattern[];
}

/**
 * Pattern flags accepted by the constituents/filter BE pipeline.
 * Must stay in sync with `PatternType` in
 * `packages/api/src/modules/constituents/filters/types.ts` — the BE rejects
 * unknown values with `Invalid pattern: …` from `FilterService.validateQuery`.
 */
export type FilterPattern =
  | "LYBUNT" // Last Year But Unfortunately Not This Year
  | "SYBUNT" // Some Year But Unfortunately Not This Year
  | "RECURRING" // Regular giving pattern (>=3 cleared donations in last 12 months)
  | "LAPSED" // No cleared donation in the last 12 months but donated before
  | "MAJOR_DONOR"; // Lifetime cleared donations >= 1000 EUR

export interface FilterPreset {
  id: string;
  name: string;
  description: string;
  query: FilterQuery;
  icon?: string;
}

export interface FilterField {
  name: string;
  label: string;
  /**
   * How `label` (and option labels) must be rendered (Epic #539):
   * - `"i18n"` (default when absent) — a next-intl key under the render
   *   site's filter namespace (e.g. `constituents.filters.*`), resolved
   *   through the translator.
   * - `"literal"` — operator-authored tenant data (custom-field labels),
   *   rendered verbatim, never through `t()`.
   */
  labelKind?: "literal" | "i18n";
  /**
   * Option-label rendering when it DIFFERS from `labelKind` (donations
   * catalog): `donation.campaign` / `donation.fund` have an i18n FIELD label
   * (`fields.donation.campaign`) but tenant-authored ENTITY option labels
   * (campaign/fund names) that must render literally. Defaults to
   * `labelKind` when absent, so every existing field is unaffected.
   */
  optionLabelKind?: "literal" | "i18n";
  type: FilterFieldType;
  category: FilterCategory;
  operators: FilterOperator[];
  // For select fields
  options?: Array<{ value: string; label: string }>;
  /**
   * When true the multiselect options are fetched at edit-time from
   * `GET /v1/constituents/filter/suggestions?field=<name>` rather than being a
   * fixed picklist. Used by `constituent.tags`, where values are tenant-defined.
   */
  asyncSuggestions?: boolean;
  // For numeric/date fields
  min?: number | string;
  max?: number | string;
  step?: number;
  placeholder?: string;
}

/**
 * Field groups shown as section headers in the field picker. Trimmed to the
 * categories actually backed by data — the former `donation_patterns`,
 * `engagement` and `calculated` groups were removed because every field in them
 * referenced a column that doesn't exist and 400'd on use.
 *
 * The union spans BOTH domains that reuse this builder stack:
 *  - constituents (Epic #418): identity / demographics / donation_history / custom
 *  - donations (donations.advanced_filters): donation / payment / attribution / receipt
 * Each domain's message namespace carries `categories.<value>` for exactly the
 * subset its catalog uses.
 */
export type FilterCategory =
  | "identity"
  | "demographics"
  | "donation_history"
  | "custom"
  | "donation"
  | "payment"
  | "attribution"
  | "receipt";

export interface FilterPreviewResponse {
  count: number;
  loading?: boolean;
  error?: string;
}

/**
 * Discriminated chip shape consumed by the campaign "Active selection" strip.
 *
 * Two kinds of chip can appear:
 *  - `kind: "condition"` (default) — one operator+value predicate.
 *  - `kind: "pattern"` — one BE pattern flag (LYBUNT, RECURRING, …). Patterns
 *    carry the entire semantic of pattern-only presets and previously had no
 *    visual representation; without a chip, the operator picked a preset and
 *    saw nothing in the strip explaining what was now active.
 *
 * The `kind` discriminator lets `FilterChip` pick the right layout and lets
 * the parent strip decide how to remove it (drop a condition vs. drop a
 * pattern from `FilterQuery.patterns`).
 */
export interface FilterChipData {
  id: string;
  /** Defaults to `"condition"` when omitted so existing callers stay valid. */
  kind?: "condition" | "pattern";
  label: string;
  field: string;
  operator: FilterOperator;
  value: FilterValue;
  removable?: boolean;
  /**
   * The pattern key when `kind === "pattern"`. Carried separately from `value`
   * so the strip can call `query.patterns?.filter(p => p !== pattern)` without
   * re-parsing the chip label.
   */
  pattern?: FilterPattern;
}

// Mock API types (to be replaced with real API)
// Generic result type for execute method
export interface FilterExecuteResult<T = unknown> {
  data: T[];
  total: number;
}

export interface MockFilterAPI {
  preview: (query: FilterQuery) => Promise<FilterPreviewResponse>;
  execute: <T = unknown>(query: FilterQuery) => Promise<FilterExecuteResult<T>>;
  suggest: (field: string, search: string) => Promise<string[]>;
}

// Type guard helpers for the union FilterCondition | FilterQuery
export function isFilterCondition(
  condition: FilterCondition | FilterQuery,
): condition is FilterCondition {
  return "field" in condition;
}

export function isFilterQuery(condition: FilterCondition | FilterQuery): condition is FilterQuery {
  return "conditions" in condition;
}
