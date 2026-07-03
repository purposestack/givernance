/**
 * Advanced filter types and interfaces for constituent querying
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
  | "arrayContains"
  | "arrayOverlaps"
  | "isNull"
  | "isNotNull";

export type LogicalOperator = "AND" | "OR";

export type PatternType = "LYBUNT" | "SYBUNT" | "RECURRING" | "LAPSED" | "MAJOR_DONOR";

export type FilterValue = string | number | boolean | Date | string[] | number[] | null;

export interface FilterCondition {
  field: string;
  operator: FilterOperator;
  value?: FilterValue;
  /**
   * For complex conditions that need sub-queries
   */
  subConditions?: FilterQuery;
}

export interface FilterQuery {
  operator: LogicalOperator;
  conditions: FilterCondition[];
  /**
   * Special pattern detection flags
   */
  patterns?: PatternType[];
}

export interface FilterRequest {
  query: FilterQuery;
  pagination?: {
    page: number;
    perPage: number;
  };
  sort?: {
    field: string;
    order: "asc" | "desc";
  };
}

export interface FilterPreviewRequest {
  query: FilterQuery;
}

export interface FilterSuggestionsRequest {
  field: string;
  search?: string;
  limit?: number;
}

export interface PatternConfig {
  LYBUNT?: {
    lookbackYears?: number;
  };
  SYBUNT?: {
    lookbackYears?: number;
  };
  RECURRING?: {
    minOccurrences?: number;
    windowMonths?: number;
  };
  LAPSED?: {
    monthsSinceLastDonation?: number;
  };
  MAJOR_DONOR?: {
    thresholdCents?: number;
    windowMonths?: number;
  };
}

export interface FilterResult {
  data: Record<string, unknown>[];
  pagination?: {
    page: number;
    perPage: number;
    total: number;
    totalPages: number;
  };
}

export interface FilterPreviewResult {
  count: number;
  estimatedTime?: number;
}

export interface FilterError {
  code: string;
  message: string;
  field?: string;
}

/**
 * Field metadata for validation and query building
 */
export interface FieldMetadata {
  name: string;
  type: "string" | "number" | "date" | "boolean" | "array";
  table: "constituents" | "donations" | "campaign_constituents";
  column: string;
  operators: FilterOperator[];
  /**
   * Whether this field requires aggregation (e.g., donation totals)
   */
  aggregate?: "sum" | "count" | "avg" | "max" | "min";
  /**
   * For nested fields, the join path
   */
  joinPath?: string[];
  /**
   * Unit the DSL value arrives in when it differs from the stored column unit.
   * `"cents"` means the FE sends a human amount in the base currency (EUR) and
   * the query builder multiplies by 100 before comparing against the `*_cents`
   * column. Without this, `donations.totalAmount >= 500` would compare 500
   * against `amount_base_cents` and match every donor above €5 (issue: EUR/cents
   * unit drift surfaced by the advanced-filters audit).
   */
  valueUnit?: "cents";
}

/**
 * Registry of all available filterable fields
 */
export const FIELD_REGISTRY: Record<string, FieldMetadata> = {
  // Constituent fields
  "constituent.firstName": {
    name: "constituent.firstName",
    type: "string",
    table: "constituents",
    column: "first_name",
    // first_name is NOT NULL (schema) — isNull/isNotNull would be dead
    // operators (always 0 / always everyone), so they are intentionally omitted.
    operators: ["eq", "neq", "contains", "startsWith", "endsWith"],
  },
  "constituent.lastName": {
    name: "constituent.lastName",
    type: "string",
    table: "constituents",
    column: "last_name",
    // last_name is NOT NULL — no nullable operators (see firstName).
    operators: ["eq", "neq", "contains", "startsWith", "endsWith"],
  },
  "constituent.email": {
    name: "constituent.email",
    type: "string",
    table: "constituents",
    column: "email",
    operators: ["eq", "neq", "contains", "startsWith", "endsWith", "isNull", "isNotNull"],
  },
  "constituent.phone": {
    name: "constituent.phone",
    type: "string",
    table: "constituents",
    column: "phone",
    operators: ["eq", "neq", "contains", "startsWith", "endsWith", "isNull", "isNotNull"],
  },
  "constituent.type": {
    name: "constituent.type",
    // Issue #465 — now the `types text[]` array. Legacy scalar operators
    // (eq/neq/in) are kept so persisted segments built before the migration
    // keep working: the query builder translates them to array semantics
    // against the `types` column (eq → contains, in → overlaps).
    type: "array",
    table: "constituents",
    column: "types",
    // `types` is NOT NULL with a default of `{donor}` — every constituent has
    // ≥1 type, so isNull/isNotNull are meaningless here and were removed. The
    // legacy scalar operators (eq/neq/in) stay for persisted pre-#465 segments;
    // the query builder translates them to array semantics.
    operators: ["arrayContains", "arrayOverlaps", "eq", "neq", "in"],
  },
  "constituent.tags": {
    name: "constituent.tags",
    type: "array",
    table: "constituents",
    column: "tags",
    operators: ["arrayContains", "arrayOverlaps", "isNull", "isNotNull"],
  },
  "constituent.createdAt": {
    name: "constituent.createdAt",
    type: "date",
    table: "constituents",
    column: "created_at",
    operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
  },

  // Address fields
  "address.city": {
    name: "address.city",
    type: "string",
    table: "constituents",
    column: "city",
    // `in` added so operators can pick several cities at once ("is any of");
    // the query builder already renders it via inArray.
    operators: ["eq", "neq", "contains", "startsWith", "endsWith", "in", "isNull", "isNotNull"],
  },
  "address.postalCode": {
    name: "address.postalCode",
    type: "string",
    table: "constituents",
    column: "postal_code",
    operators: ["eq", "neq", "contains", "startsWith", "endsWith", "isNull", "isNotNull"],
  },
  "address.countryCode": {
    name: "address.countryCode",
    type: "string",
    table: "constituents",
    column: "country_code",
    // country_code is nullable → isNull/isNotNull are meaningful ("no country
    // on file"). `in` supports multi-country selection.
    operators: ["eq", "neq", "in", "isNull", "isNotNull"],
  },

  // Donation fields (aggregated)
  "donations.totalAmount": {
    name: "donations.totalAmount",
    type: "number",
    table: "donations",
    column: "amount_cents",
    operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
    aggregate: "sum",
    // FE input is a human EUR amount; the aggregated column is in cents.
    valueUnit: "cents",
  },
  "donations.count": {
    name: "donations.count",
    type: "number",
    table: "donations",
    column: "id",
    operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
    aggregate: "count",
  },
  "donations.lastDate": {
    name: "donations.lastDate",
    type: "date",
    table: "donations",
    // isNull/isNotNull removed: last_donation_date is a MAX() aggregate that is
    // never NULL inside a donation_stats group, so isNotNull matched everyone
    // and isNull leaked through the aggregate-NULL wrapper. "Has ever / never
    // donated" is expressed with donations.count instead.
    column: "donated_at",
    operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
    aggregate: "max",
  },
  "donations.firstDate": {
    name: "donations.firstDate",
    type: "date",
    table: "donations",
    column: "donated_at",
    operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
    aggregate: "min",
  },
  // NOTE: `donations.averageAmount`, `campaigns.count` and `campaigns.ids` were
  // removed from the registry. They mapped to columns (`avg_amount_cents`,
  // `campaign_count`) that the runtime `donation_stats` subquery never selects
  // and to a campaign join that is never wired, so any query on them raised a
  // Postgres 42703 → 500. They are tracked as roadmap items in
  // docs/30-advanced-filters.md until the aggregation is actually joined.
};
