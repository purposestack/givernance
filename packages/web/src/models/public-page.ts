import type { CampaignPublicPageColor } from "@givernance/shared/validators";

export type PublicPageStatus = "draft" | "published";
export type PublicDonationCurrency = "EUR" | "CHF";

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

export interface PublishedCampaignPublicPage {
  id: string;
  campaignId: string;
  title: string;
  description: string | null;
  colorPrimary: CampaignPublicPageColor | null;
  goalAmountCents: number | null;
}

export interface PublishedCampaignPublicPageResponse {
  data: PublishedCampaignPublicPage;
}

export interface CampaignPublicPageInput {
  title: string;
  description?: string | null;
  colorPrimary?: CampaignPublicPageColor | null;
  goalAmountCents?: number | null;
  status?: PublicPageStatus;
}

export interface PublicDonationIntentInput {
  amountCents: number;
  currency: PublicDonationCurrency;
  email: string;
  firstName: string;
  lastName: string;
}

export interface PublicDonationIntent {
  clientSecret: string;
}

export interface PublicDonationIntentResponse {
  data: PublicDonationIntent;
}
