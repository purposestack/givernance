export type PublicPageStatus = "draft" | "published";

export interface CampaignPublicPage {
  id: string;
  orgId: string;
  campaignId: string;
  status: PublicPageStatus;
  title: string;
  description: string | null;
  colorPrimary: string | null;
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
  colorPrimary?: string | null;
  goalAmountCents?: number | null;
  status?: PublicPageStatus;
}
