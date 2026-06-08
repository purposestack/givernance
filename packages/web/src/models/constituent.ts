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
  /**
   * Postal address (Epic #274 follow-up). When the three required
   * fields (`addressLine1`, `postalCode`, `city`) are present, the
   * postal-letter renderer puts the recipient block in the standard
   * French DL window position so the letter fits a window envelope
   * after a Z-fold. NULL on rows seeded before this feature shipped.
   */
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
  /** ISO 3166-1 alpha-2 (e.g. `FR`, `BE`). NULL = no country line printed. */
  countryCode: string | null;
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
  /** Epic #274 — restrict to constituents linked to a specific campaign. */
  campaignId?: string;
  /** Exclude constituents already linked to this campaign (the add-members picker). */
  excludeCampaignId?: string;
  /** ISO date — `MAX(donations.donatedAt) >= lastDonationFrom`. */
  lastDonationFrom?: string;
  /** ISO date — `MAX(donations.donatedAt) <= lastDonationTo`. */
  lastDonationTo?: string;
  /** Lifetime cleared base cents (lower bound). */
  minLifetimeAmountCents?: number;
  /** Lifetime cleared base cents (upper bound). */
  maxLifetimeAmountCents?: number;
}

export function fullName(constituent: Constituent): string {
  return `${constituent.firstName} ${constituent.lastName}`.trim();
}

export function initials(constituent: Constituent): string {
  const first = constituent.firstName?.[0] ?? "";
  const last = constituent.lastName?.[0] ?? "";
  return `${first}${last}`.toUpperCase() || "?";
}
