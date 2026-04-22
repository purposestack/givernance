import type { CampaignPublicPageSchema } from "@givernance/shared/validators";
import type { Static } from "@sinclair/typebox";

import type { ApiClient } from "@/lib/api";
import { isUuid } from "@/lib/uuid";
import type {
  CampaignPublicPage,
  CampaignPublicPageInput,
  CampaignPublicPageResponse,
  PublicDonationIntent,
  PublicDonationIntentInput,
  PublishedCampaignPublicPage,
  PublishedCampaignPublicPageResponse,
} from "@/models/public-page";

type CampaignPublicPagePayload = Static<typeof CampaignPublicPageSchema>;

function requireCampaignId(campaignId: string): string {
  if (!isUuid(campaignId)) {
    throw new Error(`Invalid campaign ID: ${JSON.stringify(campaignId)}`);
  }

  return campaignId;
}

export const CampaignPublicPageService = {
  async getCampaignPublicPage(client: ApiClient, campaignId: string): Promise<CampaignPublicPage> {
    const safeCampaignId = requireCampaignId(campaignId);
    const response = await client.get<CampaignPublicPageResponse>(
      `/v1/campaigns/${encodeURIComponent(safeCampaignId)}/public-page`,
    );
    return response.data;
  },

  async getPublishedCampaignPublicPage(
    client: ApiClient,
    campaignId: string,
  ): Promise<PublishedCampaignPublicPage> {
    const safeCampaignId = requireCampaignId(campaignId);
    const response = await client.get<PublishedCampaignPublicPageResponse>(
      `/v1/public/campaigns/${encodeURIComponent(safeCampaignId)}/page`,
    );
    return response.data;
  },

  async upsertCampaignPublicPage(
    client: ApiClient,
    campaignId: string,
    input: CampaignPublicPageInput,
  ): Promise<CampaignPublicPage> {
    const safeCampaignId = requireCampaignId(campaignId);
    const response = await client.put<CampaignPublicPageResponse>(
      `/v1/campaigns/${encodeURIComponent(safeCampaignId)}/public-page`,
      toRequestBody(input),
    );
    return response.data;
  },

  async createPublicDonationIntent(
    client: ApiClient,
    campaignId: string,
    input: PublicDonationIntentInput,
    idempotencyKey?: string,
  ): Promise<PublicDonationIntent> {
    const safeCampaignId = requireCampaignId(campaignId);
    const response = await client.post<{ data: PublicDonationIntent }>(
      `/v1/public/campaigns/${encodeURIComponent(safeCampaignId)}/donate`,
      input,
      {
        headers: idempotencyKey ? { "idempotency-key": idempotencyKey } : undefined,
      },
    );
    return response.data;
  },
};

function toRequestBody(input: CampaignPublicPageInput): CampaignPublicPagePayload {
  const body: CampaignPublicPagePayload = {
    title: input.title,
  };

  if (input.description !== undefined) body.description = input.description;
  if (input.colorPrimary !== undefined) body.colorPrimary = input.colorPrimary;
  if (input.goalAmountCents !== undefined) body.goalAmountCents = input.goalAmountCents;
  if (input.status !== undefined) body.status = input.status;

  return body;
}
