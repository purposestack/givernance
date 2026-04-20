import type { Pagination } from "@/models/constituent";

export type CampaignType = "nominative_postal" | "door_drop" | "digital";
export type CampaignStatus = "draft" | "active" | "closed";

export interface Campaign {
  id: string;
  orgId: string;
  name: string;
  type: CampaignType;
  status: CampaignStatus;
  parentId: string | null;
  costCents: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignListQuery {
  page?: number;
  perPage?: number;
  status?: CampaignStatus;
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

export interface CampaignStatsResponse {
  data: CampaignStats;
}
