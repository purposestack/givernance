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
    operators: ["eq", "neq", "contains", "startsWith", "endsWith", "isNull", "isNotNull"],
  },
  "constituent.lastName": {
    name: "constituent.lastName",
    type: "string",
    table: "constituents",
    column: "last_name",
    operators: ["eq", "neq", "contains", "startsWith", "endsWith", "isNull", "isNotNull"],
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
    type: "string",
    table: "constituents",
    column: "type",
    operators: ["eq", "neq", "in"],
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
    operators: ["eq", "neq", "contains", "startsWith", "endsWith", "isNull", "isNotNull"],
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
    operators: ["eq", "neq", "in"],
  },

  // Donation fields (aggregated)
  "donations.totalAmount": {
    name: "donations.totalAmount",
    type: "number",
    table: "donations",
    column: "amount_cents",
    operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
    aggregate: "sum",
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
    column: "donated_at",
    operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "isNull", "isNotNull"],
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
  "donations.averageAmount": {
    name: "donations.averageAmount",
    type: "number",
    table: "donations",
    column: "amount_cents",
    operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
    aggregate: "avg",
  },

  // Campaign participation
  "campaigns.count": {
    name: "campaigns.count",
    type: "number",
    table: "campaign_constituents",
    column: "campaign_id",
    operators: ["eq", "neq", "gt", "gte", "lt", "lte"],
    aggregate: "count",
  },
  "campaigns.ids": {
    name: "campaigns.ids",
    type: "array",
    table: "campaign_constituents",
    column: "campaign_id",
    operators: ["in", "arrayContains"],
  },
};
