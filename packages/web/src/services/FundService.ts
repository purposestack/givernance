import type { ApiClient } from "@/lib/api";
import type {
  Fund,
  FundCampaignListResponse,
  FundCreateInput,
  FundDetailResponse,
  FundListQuery,
  FundListResponse,
} from "@/models/fund";

export const FundService = {
  async listFunds(client: ApiClient, query: FundListQuery = {}): Promise<FundListResponse> {
    const response = await client.get<FundListResponse>("/v1/funds", {
      params: {
        page: query.page ?? 1,
        perPage: query.perPage ?? 20,
      },
    });

    return {
      data: response.data.map(mapFund),
      pagination: response.pagination,
    };
  },

  async createFund(client: ApiClient, input: FundCreateInput): Promise<Fund> {
    const response = await client.post<FundDetailResponse>("/v1/funds", toRequestBody(input));
    return mapFund(response.data);
  },

  async listCampaignFunds(client: ApiClient, campaignId: string): Promise<Fund[]> {
    const response = await client.get<FundCampaignListResponse>(
      `/v1/campaigns/${encodeURIComponent(campaignId)}/funds`,
    );
    return response.data.map(mapFund);
  },
};

function mapFund(raw: Fund): Fund {
  return {
    id: raw.id,
    orgId: raw.orgId,
    name: raw.name,
    description: raw.description,
    type: raw.type,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

function toRequestBody(input: FundCreateInput): Record<string, unknown> {
  return {
    name: input.name,
    description: input.description ?? null,
    type: input.type ?? "unrestricted",
  };
}
