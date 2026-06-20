/**
 * Advanced filter type definitions for constituent segmentation.
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
  | "notIn"
  | "contains"
  | "notContains"
  | "startsWith"
  | "endsWith"
  | "exists"
  | "notExists"
  // Array-column operators (issue #465). `constituent.type` migrated from a
  // scalar to a `text[]`; these map to Drizzle `arrayContains` (all-of) /
  // `arrayOverlaps` (any-of) BE-side.
  | "arrayContains"
  | "arrayOverlaps";

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
  type: FilterFieldType;
  category: FilterCategory;
  operators: FilterOperator[];
  // For select fields
  options?: Array<{ value: string; label: string }>;
  // For numeric/date fields
  min?: number | string;
  max?: number | string;
  step?: number;
  placeholder?: string;
}

export type FilterCategory =
  | "donation_history"
  | "donation_patterns"
  | "demographics"
  | "engagement"
  | "calculated";

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
