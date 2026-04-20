/**
 * Frontend Donation model — plain types that mirror the API's JSON shape.
 *
 * ADR-013: the web package never imports Drizzle schema or backend types.
 * These types are hand-written to match the response contract of
 * GET /v1/donations (packages/api/src/modules/donations/routes.ts).
 */

import type { Pagination } from "@/models/constituent";

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

export interface DonationListResponse {
  data: Donation[];
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
