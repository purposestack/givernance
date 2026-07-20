/**
 * Frontend Constituent model — plain types that mirror the API's JSON shape.
 *
 * ADR-013: the web package never imports Drizzle schema or backend types.
 * These types are hand-written to match the response contract of
 * GET /v1/constituents (packages/api/src/modules/constituents/routes.ts).
 */

import type { CustomFieldValues } from "@givernance/shared/custom-fields";

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
  /**
   * Canonical multi-valued type (issue #465). A constituent can be e.g. both a
   * donor AND a volunteer. The API always returns at least one element.
   * The list/badge surfaces render every entry as a chip (with a `+N` overflow
   * in tight table cells) when the `constituents.multi_type` flag is on.
   */
  types: Array<ConstituentType | string>;
  /**
   * Legacy singular type — kept for back-compat, always equal to `types[0]`.
   * Prefer `types`; this field exists so single-type surfaces (and code paths
   * gated by a disabled `constituents.multi_type` flag) keep working unchanged.
   */
  type: ConstituentType | string;
  tags: string[] | null;
  /**
   * Custom-field values keyed by definition key (Epic #539). Serialised
   * server-side through the definition-driven serializer — only keys with an
   * active definition appear. Absent on older API builds or when the
   * `constituents.custom_fields` flag is off.
   */
  custom?: CustomFieldValues;
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
  /** Legacy single-value type filter (`?type=donor`). */
  type?: ConstituentType;
  /**
   * Multi-value type filter (issue #465). Serialised as repeatable
   * `?types=donor&types=volunteer` and matched by array-overlap server-side.
   * Used by the list quick-filter when `constituents.multi_type` is on.
   */
  types?: ConstituentType[];
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
  /**
   * Advanced-filter DSL (Epic #418 / ADR-033): a JSON-serialised `FilterQuery`
   * passed through verbatim from the `?filters=` URL param. Only sent when the
   * `advanced_filters` flag is on — the API 404s the param when the flag is
   * off, mirroring the gated /constituents/filter routes.
   */
  filters?: string;
}

export function fullName(constituent: Constituent): string {
  return `${constituent.firstName} ${constituent.lastName}`.trim();
}

export function initials(constituent: Constituent): string {
  const first = constituent.firstName?.[0] ?? "";
  const last = constituent.lastName?.[0] ?? "";
  return `${first}${last}`.toUpperCase() || "?";
}
