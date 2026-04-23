import type { Pagination } from "@/models/constituent";

export type FundType = "restricted" | "unrestricted";

export interface Fund {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  type: FundType;
  createdAt: string;
  updatedAt: string;
}

export interface FundListQuery {
  page?: number;
  perPage?: number;
}

export interface FundListResponse {
  data: Fund[];
  pagination: Pagination;
}

export interface FundDetailResponse {
  data: Fund;
}

export interface FundCreateInput {
  name: string;
  description?: string | null;
  type?: FundType;
}

export interface FundCampaignListResponse {
  data: Fund[];
}
