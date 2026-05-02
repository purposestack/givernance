/** Shared TypeBox schemas — reusable across all route modules */

import { type TObject, Type } from "@sinclair/typebox";

/** UUID v4 pattern used for all entity IDs */
const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

/** Reusable UUID string schema */
export const UuidSchema = Type.String({ pattern: UUID_PATTERN });

export function isUuid(value: string): boolean {
  return new RegExp(UUID_PATTERN, "i").test(value);
}

/** Standard :id route parameter */
export const IdParams = Type.Object({ id: UuidSchema });

/** Pagination query parameters (page + perPage) */
export const PaginationQuery = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  perPage: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
});

/**
 * Sort direction shared across list endpoints. Used alongside a per-route
 * `sort` whitelist (literal union) so unknown sort fields fail closed with
 * a 400 RFC 9457 body — see issue #209.
 */
export const SortOrderSchema = Type.Union([Type.Literal("asc"), Type.Literal("desc")]);

/** RFC 9457 Problem Details response schema (all members optional per spec) */
export const ProblemDetailSchema = Type.Object(
  {
    type: Type.Optional(Type.String()),
    title: Type.Optional(Type.String()),
    status: Type.Optional(Type.Integer()),
    detail: Type.Optional(Type.String()),
    instance: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

/** Supported ISO 4217 currency codes for European NPOs */
export const CurrencySchema = Type.Union([
  Type.Literal("EUR"),
  Type.Literal("GBP"),
  Type.Literal("CHF"),
  Type.Literal("SEK"),
  Type.Literal("NOK"),
  Type.Literal("DKK"),
  Type.Literal("PLN"),
  Type.Literal("CZK"),
]);

/** Pagination metadata in list responses */
export const PaginationSchema = Type.Object({
  page: Type.Integer(),
  perPage: Type.Integer(),
  total: Type.Integer(),
  totalPages: Type.Integer(),
});

/** Build a { data: T } response wrapper */
export function DataResponse(schema: TObject) {
  return Type.Object({ data: schema });
}

/** Build a { data: T[] } list response wrapper */
export function DataArrayResponse(schema: TObject) {
  return Type.Object({
    data: Type.Array(schema),
    pagination: PaginationSchema,
  });
}

/** Build a { data: T[] } list response without pagination */
export function DataArrayResponseNoPagination(schema: TObject) {
  return Type.Object({ data: Type.Array(schema) });
}

/** Standard error responses to include in every route's response schema */
export const ErrorResponses = {
  401: ProblemDetailSchema,
  403: ProblemDetailSchema,
  404: ProblemDetailSchema,
};

/**
 * Helper to create an RFC 9457 problem detail object. Optional `extensions`
 * are spread into the body — RFC 9457 §3.2 explicitly allows additional
 * members (e.g. `reason`, `step_up_required` on the impersonation 401 in
 * issue #250). Keep extension keys snake_case to match the wire-format
 * convention used elsewhere in problem responses.
 */
export function problemDetail(
  status: number,
  title: string,
  detail: string,
  extensions?: Record<string, unknown>,
) {
  return {
    type: `https://httpproblems.com/http-status/${status}`,
    title,
    status,
    detail,
    ...extensions,
  };
}

/** Content-Type for RFC 9457 responses */
export const PROBLEM_JSON = "application/problem+json";
