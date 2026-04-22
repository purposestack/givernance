import type { CampaignPublicPageColor } from "@givernance/shared/validators";

export type PublicPageStatus = "draft" | "published";

export interface CampaignPublicPage {
  id: string;
  orgId: string;
  campaignId: string;
  status: PublicPageStatus;
  title: string;
  description: string | null;
  colorPrimary: CampaignPublicPageColor | null;
  goalAmountCents: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignPublicPageResponse {
  data: CampaignPublicPage;
}

export interface CampaignPublicPageInput {
  title: string;
  description?: string | null;
  colorPrimary?: CampaignPublicPageColor | null;
  goalAmountCents?: number | null;
  status?: PublicPageStatus;
}
