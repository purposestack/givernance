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

export interface Pagination {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

export interface ConstituentListResponse {
  data: Constituent[];
  pagination: Pagination;
}

export interface ConstituentDetailResponse {
  data: Constituent;
}

export interface ConstituentListQuery {
  page?: number;
  perPage?: number;
  search?: string;
  type?: ConstituentType;
}

export function fullName(constituent: Constituent): string {
  return `${constituent.firstName} ${constituent.lastName}`.trim();
}

export function initials(constituent: Constituent): string {
  const first = constituent.firstName?.[0] ?? "";
  const last = constituent.lastName?.[0] ?? "";
  return `${first}${last}`.toUpperCase() || "?";
}
