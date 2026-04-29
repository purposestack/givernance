/**
 * Frontend Constituent model — plain types that mirror the API's JSON shape.
 *
 * ADR-013: the web package never imports Drizzle schema or backend types.
 * These types are hand-written to match the response contract of
 * GET /v1/constituents (packages/api/src/modules/constituents/routes.ts).
 */

export type ConstituentType = "donor" | "volunteer" | "member" | "beneficiary" | "partner";

export interface Constituent {
  id: string;
  orgId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  type: ConstituentType | string;
  tags: string[] | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * List-only enrichment: latest donation date for the constituent, or
 * `null` if they've never donated. Surfaced by the API's
 * `GET /v1/constituents` LEFT JOIN aggregate (issue #215). The detail
 * route does not return this field.
 */
export interface ConstituentListRow extends Constituent {
  lastDonationAt: string | null;
}

export interface Pagination {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

export interface ConstituentListResponse {
  data: ConstituentListRow[];
  pagination: Pagination;
}

export interface ConstituentDetailResponse {
  data: Constituent;
}

export type ConstituentSortField = "name" | "type" | "email" | "lastDonation" | "createdAt";
export type ConstituentSortOrder = "asc" | "desc";

export interface ConstituentListQuery {
  page?: number;
  perPage?: number;
  search?: string;
  type?: ConstituentType;
  sort?: ConstituentSortField;
  order?: ConstituentSortOrder;
}

export function fullName(constituent: Constituent): string {
  return `${constituent.firstName} ${constituent.lastName}`.trim();
}

export function initials(constituent: Constituent): string {
  const first = constituent.firstName?.[0] ?? "";
  const last = constituent.lastName?.[0] ?? "";
  return `${first}${last}`.toUpperCase() || "?";
}
