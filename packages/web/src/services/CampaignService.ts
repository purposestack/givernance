import type { ApiClient } from "@/lib/api";
import type {
  Campaign,
  CampaignListQuery,
  CampaignListResponse,
  CampaignStats,
  CampaignStatsResponse,
} from "@/models/campaign";

/**
 * CampaignService — ADR-011 Layer 2 (services).
 *
 * The API list endpoint does not expose a status query yet. Keep status
 * filtering in this web adapter for dashboard reads until the API contract
 * grows that filter.
 */
export const CampaignService = {
  async listCampaigns(
    client: ApiClient,
    query: CampaignListQuery = {},
  ): Promise<CampaignListResponse> {
    const page = query.page ?? 1;
    const perPage = query.perPage ?? 20;
    const requestPerPage = query.status ? Math.max(perPage, 100) : perPage;

    const response = await client.get<CampaignListResponse>("/v1/campaigns", {
      params: { page, perPage: requestPerPage },
    });

    const data = response.data.map(mapCampaign);

    if (!query.status) {
      return { data, pagination: response.pagination };
    }

    const filtered = data.filter((campaign) => campaign.status === query.status);

    return {
      data: filtered.slice(0, perPage),
      pagination: {
        page,
        perPage,
        total: filtered.length,
        totalPages: Math.ceil(filtered.length / perPage),
      },
    };
  },

  async getCampaignStats(client: ApiClient, id: string): Promise<CampaignStats> {
    const response = await client.get<CampaignStatsResponse>(
      `/v1/campaigns/${encodeURIComponent(id)}/stats`,
    );
    return response.data;
  },
};

function mapCampaign(raw: Campaign): Campaign {
  return {
    id: raw.id,
    orgId: raw.orgId,
    name: raw.name,
    type: raw.type,
    status: raw.status,
    parentId: raw.parentId,
    costCents: raw.costCents,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}
