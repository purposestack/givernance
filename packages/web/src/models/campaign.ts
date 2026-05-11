import type { Pagination } from "@/models/constituent";

export type CampaignType = "nominative_postal" | "door_drop" | "digital";
export type CampaignStatus = "draft" | "active" | "closed";
export type CampaignCurrency = "EUR" | "GBP" | "CHF";

/** Per-campaign override on the QR-bill reference type (Epic #318). */
export type CampaignQrReferenceMode = "auto" | "qrr" | "scor";

export interface Campaign {
  id: string;
  orgId: string;
  name: string;
  /**
   * Free-form admin description (Epic #274 follow-up). Drives the body
   * of the postal letter and seeds the public donation page on first
   * publish. NULL when the operator has not filled it yet.
   */
  description: string | null;
  type: CampaignType;
  status: CampaignStatus;
  defaultCurrency: CampaignCurrency;
  parentId: string | null;
  operationalCostCents: number | null;
  platformFeesCents: number;
  goalAmountCents: number | null;
  /**
   * Epic #318 — Swiss QR-bill discriminator. NULL = standard postal
   * rail (no QR-bill); set = Swiss QR-bill mode active (every export
   * appends a QR-bill PDF alongside the appeal letter).
   */
  bankAccountId: string | null;
  qrReferenceMode: CampaignQrReferenceMode;
  createdAt: string;
  updatedAt: string;
}

export type CampaignSortField = "name" | "type" | "status" | "progress" | "createdAt";
export type CampaignSortOrder = "asc" | "desc";

export interface CampaignListQuery {
  page?: number;
  perPage?: number;
  status?: CampaignStatus;
  search?: string;
  sort?: CampaignSortField;
  order?: CampaignSortOrder;
}

export interface CampaignListResponse {
  data: Campaign[];
  pagination: Pagination;
}

export interface CampaignStats {
  campaignId: string;
  totalRaisedCents: number;
  donationCount: number;
  uniqueDonors: number;
}

export interface CampaignRoiMetrics {
  campaignId: string;
  rawGoalCents: number | null;
  rawRaisedCents: number;
  rawPlatformFeesCents: number;
  rawOperationalCostCents: number | null;
  totalCostCents: number;
  roiPct: number | null;
}

export interface CampaignStatsResponse {
  data: CampaignStats;
}

export interface CampaignRoiResponse {
  data: CampaignRoiMetrics;
}

export interface CampaignDetailResponse {
  data: Campaign;
}

export interface CampaignCreateInput {
  name: string;
  /** `null` clears, `undefined` leaves alone, `string` sets. */
  description?: string | null;
  type: CampaignType;
  defaultCurrency?: CampaignCurrency;
  parentId?: string | null;
  operationalCostCents?: number | null;
  goalAmountCents?: number | null;
  fundIds?: string[];
  /**
   * Epic #318 — link to a `bank_accounts.id` row in the same org. NULL
   * unlinks (drops back to standard mode); `undefined` leaves alone.
   * Server enforces same-tenant + active (not soft-deleted).
   */
  bankAccountId?: string | null;
  qrReferenceMode?: CampaignQrReferenceMode;
}

export type CampaignUpdateInput = Partial<CampaignCreateInput> & {
  status?: CampaignStatus;
};
