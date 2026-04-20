/**
 * Frontend Donation model — plain types that mirror the API's JSON shape.
 *
 * ADR-013: the web package never imports Drizzle schema or backend types.
 * These types are hand-written to match the response contract of
 * GET /v1/donations (packages/api/src/modules/donations/routes.ts).
 */

import type { Pagination } from "@/models/constituent";

export type ReceiptStatus = "pending" | "generated" | "failed";

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
  fiscalYear: number;
  createdAt: string;
  updatedAt: string;
}

export interface DonationListRow extends Donation {
  constituent: { firstName: string; lastName: string } | null;
  receiptStatus: ReceiptStatus | null;
}

export interface DonationListResponse {
  data: DonationListRow[];
  pagination: Pagination;
}

export interface DonationListQuery {
  page?: number;
  perPage?: number;
  constituentId?: string;
  campaignId?: string;
  dateFrom?: string;
  dateTo?: string;
  amountMin?: number;
  amountMax?: number;
}

export interface DonationAllocation {
  id: string;
  fundId: string;
  amountCents: number;
}

export interface DonationAllocationInput {
  fundId: string;
  amountCents: number;
}

export interface DonationDetail extends Donation {
  constituent: {
    id: string;
    firstName: string;
    lastName: string;
    email: string | null;
  };
  allocations: DonationAllocation[];
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
}

export interface DonationReceiptUrl {
  url: string;
}

export function donationDonorName(row: DonationListRow): string | null {
  if (!row.constituent) return null;
  const name = `${row.constituent.firstName} ${row.constituent.lastName}`.trim();
  return name.length > 0 ? name : null;
}

export function donationDetailDonorName(detail: DonationDetail): string {
  return `${detail.constituent.firstName} ${detail.constituent.lastName}`.trim();
}
