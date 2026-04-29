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

export type FundSortField = "name" | "type" | "createdAt";
export type FundSortOrder = "asc" | "desc";

export interface FundListQuery {
  page?: number;
  perPage?: number;
  sort?: FundSortField;
  order?: FundSortOrder;
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

export interface FundUpdateInput {
  name?: string;
  description?: string | null;
  type?: FundType;
}

export interface FundCampaignListResponse {
  data: Fund[];
}
