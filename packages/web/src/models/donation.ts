/**
 * Frontend Donation model — plain types that mirror the API's JSON shape.
 *
 * ADR-013: the web package never imports Drizzle schema or backend types.
 * These types are hand-written to match the response contract of
 * GET /v1/donations (packages/api/src/modules/donations/routes.ts).
 */

import type { CustomFieldValues } from "@givernance/shared/custom-fields";
import type { Pagination } from "@/models/constituent";

export type ReceiptStatus = "pending" | "generated" | "failed";

/**
 * Donation lifecycle status as exposed by `GET /v1/donations/:id`. Issue
 * #199 — the refund button hides itself when status is already `refunded`.
 */
export type DonationStatus = "pending" | "cleared" | "refunded" | "failed";

export interface Donation {
  id: string;
  orgId: string;
  constituentId: string;
  amountCents: number;
  currency: string;
  campaignId: string | null;
  paymentMethod: string | null;
  paymentRef: string | null;
  donatedAt: string;
  fiscalYear: number | null;
  /**
   * Donation-domain custom-field values (Epic #539), keyed by definition
   * key. Absent on older API builds or when `donations.custom_fields` is
   * off for the tenant.
   */
  custom?: CustomFieldValues;
  createdAt: string;
  updatedAt: string;
}

export interface DonationListRow extends Donation {
  constituent: { firstName: string; lastName: string } | null;
  campaign: { name: string } | null;
  receiptStatus: ReceiptStatus | null;
  /**
   * Cross-domain projection (Epic #539 §6): the linked constituent's
   * `showOnRelated ∧ ¬sensitive` custom values. Eligibility is recomputed
   * server-side per request — render defensively when absent.
   */
  donorCustom?: CustomFieldValues;
}

export interface DonationListResponse {
  data: DonationListRow[];
  pagination: Pagination;
}

export type DonationSortField =
  | "donatedAt"
  | "amountCents"
  | "paymentMethod"
  | "donor"
  | "campaign"
  | "createdAt";
export type DonationSortOrder = "asc" | "desc";

export interface DonationListQuery {
  page?: number;
  perPage?: number;
  search?: string;
  constituentId?: string;
  campaignId?: string;
  dateFrom?: string;
  dateTo?: string;
  amountMin?: number;
  amountMax?: number;
  receiptStatus?: "pending" | "generated" | "failed";
  sort?: DonationSortField;
  order?: DonationSortOrder;
  /**
   * Advanced-filter DSL as a JSON string (flag `donations.advanced_filters`).
   * Forwarded verbatim as the `?filters=` query param — the API 404s it when
   * the flag is off, so callers must only set it when the SSR-fetched flag
   * is on.
   */
  filters?: string;
}

export interface DonationAllocation {
  id: string;
  fundId: string;
  fundName: string;
  amountCents: number;
}

export interface DonationAllocationInput {
  fundId: string;
  amountCents: number;
}

export interface DonationDetail extends Donation {
  /** Lifecycle status — see `DonationStatus`. Drives the refund button. */
  status: DonationStatus;
  constituent: {
    id: string;
    firstName: string;
    lastName: string;
    email: string | null;
  };
  allocations: DonationAllocation[];
  /** Cross-domain projection — see `DonationListRow.donorCustom`. */
  donorCustom?: CustomFieldValues;
}

export interface DonationDetailResponse {
  data: DonationDetail;
}

export interface DonationCreateInput {
  constituentId: string;
  amountCents: number;
  currency?: string;
  campaignId?: string;
  paymentMethod?: string;
  paymentRef?: string;
  donatedAt?: string;
  fiscalYear?: number;
  allocations?: DonationAllocationInput[];
  /** Merge-patch of custom values (Epic #539): absent = untouched, null clears a key. */
  custom?: Record<string, unknown>;
}

export interface DonationUpdateInput {
  constituentId: string;
  amountCents: number;
  currency?: string;
  campaignId?: string | null;
  paymentMethod?: string | null;
  paymentRef?: string | null;
  donatedAt?: string;
  fiscalYear?: number | null;
  allocations?: DonationAllocationInput[];
  /** Merge-patch of custom values (Epic #539): absent = untouched, null clears a key. */
  custom?: Record<string, unknown>;
}

/**
 * Receipt metadata returned by `GET /v1/donations/:id/receipt`. Always a
 * relative same-origin path — the API streams the PDF through
 * `:id/receipt/download` so the donor never leaves the app's apex (issue
 * #214). No presigned URL field; if you see one, the contract drifted.
 *
 * `expiresAt` reflects the caller's auth-token horizon (after that the
 * user must re-auth before calling the download endpoint). The path
 * itself is timeless because the API re-authenticates on every fetch.
 */
export interface DonationReceiptMeta {
  downloadPath: string;
  expiresAt: string;
}

export function donationDonorName(row: DonationListRow): string | null {
  if (!row.constituent) return null;
  const name = `${row.constituent.firstName} ${row.constituent.lastName}`.trim();
  return name.length > 0 ? name : null;
}

export function donationDetailDonorName(detail: DonationDetail): string {
  return `${detail.constituent.firstName} ${detail.constituent.lastName}`.trim();
}
