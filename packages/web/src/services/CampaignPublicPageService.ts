import type { CampaignPublicPageSchema } from "@givernance/shared/validators";
import type { Static } from "@sinclair/typebox";

import type { ApiClient } from "@/lib/api";
import type {
  CampaignPublicPage,
  CampaignPublicPageInput,
  CampaignPublicPageResponse,
} from "@/models/public-page";

type CampaignPublicPagePayload = Static<typeof CampaignPublicPageSchema>;

export const CampaignPublicPageService = {
  async getCampaignPublicPage(client: ApiClient, campaignId: string): Promise<CampaignPublicPage> {
    const response = await client.get<CampaignPublicPageResponse>(
      `/v1/campaigns/${encodeURIComponent(campaignId)}/public-page`,
    );
    return response.data;
  },

  async upsertCampaignPublicPage(
    client: ApiClient,
    campaignId: string,
    input: CampaignPublicPageInput,
  ): Promise<CampaignPublicPage> {
    const response = await client.put<CampaignPublicPageResponse>(
      `/v1/campaigns/${encodeURIComponent(campaignId)}/public-page`,
      toRequestBody(input),
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
