import type { ApiClient } from "@/lib/api";
import type {
  Campaign,
  CampaignCreateInput,
  CampaignDetailResponse,
  CampaignListQuery,
  CampaignListResponse,
  CampaignRoiMetrics,
  CampaignRoiResponse,
  CampaignStats,
  CampaignStatsResponse,
  CampaignUpdateInput,
} from "@/models/campaign";
import type { Fund } from "@/models/fund";

/** CampaignService — ADR-011 Layer 2 (services). */
export const CampaignService = {
  async listCampaigns(
    client: ApiClient,
    query: CampaignListQuery = {},
  ): Promise<CampaignListResponse> {
    const page = query.page ?? 1;
    const perPage = query.perPage ?? 20;

    const response = await client.get<CampaignListResponse>("/v1/campaigns", {
      params: {
        page,
        perPage,
        search: query.search,
        status: query.status,
        sort: query.sort,
        order: query.order,
      },
    });

    return { data: response.data.map(mapCampaign), pagination: response.pagination };
  },

  async getCampaignStats(client: ApiClient, id: string): Promise<CampaignStats> {
    const response = await client.get<CampaignStatsResponse>(
      `/v1/campaigns/${encodeURIComponent(id)}/stats`,
    );
    return response.data;
  },

  async getCampaignRoi(client: ApiClient, id: string): Promise<CampaignRoiMetrics> {
    const response = await client.get<CampaignRoiResponse>(
      `/v1/campaigns/${encodeURIComponent(id)}/roi`,
    );
    return response.data;
  },

  async getCampaign(client: ApiClient, id: string): Promise<Campaign> {
    const response = await client.get<CampaignDetailResponse>(
      `/v1/campaigns/${encodeURIComponent(id)}`,
    );
    return mapCampaign(response.data);
  },

  async getCampaignFunds(client: ApiClient, id: string): Promise<Fund[]> {
    const response = await client.get<{ data: Fund[] }>(
      `/v1/campaigns/${encodeURIComponent(id)}/funds`,
    );
    return response.data;
  },

  async createCampaign(client: ApiClient, input: CampaignCreateInput): Promise<Campaign> {
    const response = await client.post<CampaignDetailResponse>(
      "/v1/campaigns",
      toRequestBody(input),
    );
    return mapCampaign(response.data);
  },

  async updateCampaign(
    client: ApiClient,
    id: string,
    input: CampaignUpdateInput,
  ): Promise<Campaign> {
    const response = await client.patch<CampaignDetailResponse>(
      `/v1/campaigns/${encodeURIComponent(id)}`,
      toRequestBody(input),
    );
    return mapCampaign(response.data);
  },

  async closeCampaign(client: ApiClient, id: string): Promise<Campaign> {
    const response = await client.post<CampaignDetailResponse>(
      `/v1/campaigns/${encodeURIComponent(id)}/close`,
      {},
    );
    return mapCampaign(response.data);
  },

  // ── Epic #274 — Constituent linkage and ZIP exports ────────────────────

  async listLinkedConstituents(
    client: ApiClient,
    id: string,
    query: { page?: number; perPage?: number; search?: string } = {},
  ): Promise<LinkedConstituentsResponse> {
    const response = await client.get<LinkedConstituentsResponse>(
      `/v1/campaigns/${encodeURIComponent(id)}/constituents`,
      {
        params: {
          page: query.page,
          perPage: query.perPage,
          search: query.search || undefined,
        },
      },
    );
    return response;
  },

  async attachConstituents(
    client: ApiClient,
    id: string,
    constituentIds: string[],
  ): Promise<{ attached: number; skipped: number }> {
    const response = await client.post<{ data: { attached: number; skipped: number } }>(
      `/v1/campaigns/${encodeURIComponent(id)}/constituents`,
      { constituentIds },
    );
    return response.data;
  },

  async detachConstituent(client: ApiClient, id: string, constituentId: string): Promise<void> {
    await client.delete<void>(
      `/v1/campaigns/${encodeURIComponent(id)}/constituents/${encodeURIComponent(constituentId)}`,
    );
  },

  async createExport(
    client: ApiClient,
    id: string,
    mode: "door_drop" | "nominative",
  ): Promise<CampaignExportJob> {
    const response = await client.post<{ data: CampaignExportJob }>(
      `/v1/campaigns/${encodeURIComponent(id)}/exports`,
      { mode },
    );
    return response.data;
  },

  async getExport(client: ApiClient, id: string, jobId: string): Promise<CampaignExportJob> {
    const response = await client.get<{ data: CampaignExportJob }>(
      `/v1/campaigns/${encodeURIComponent(id)}/exports/${encodeURIComponent(jobId)}`,
    );
    return response.data;
  },

  async listExports(client: ApiClient, id: string): Promise<CampaignExportJob[]> {
    const response = await client.get<{ data: CampaignExportJob[] }>(
      `/v1/campaigns/${encodeURIComponent(id)}/exports`,
    );
    return response.data;
  },

  /** Build the absolute browser-side preview PDF URL — used by `<a target="_blank">`. */
  previewPdfPath(id: string, mode?: "door_drop" | "nominative"): string {
    const params = mode ? `?mode=${mode}` : "";
    return `/v1/campaigns/${encodeURIComponent(id)}/preview-pdf${params}`;
  },
};

export interface LinkedConstituentRow {
  id: string;
  constituentId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  type: string;
  addedByUserId: string | null;
  createdAt: string;
  reconciledAmountCents: number;
  reconciledDonationCount: number;
}

export interface LinkedConstituentsResponse {
  data: LinkedConstituentRow[];
  pagination: { page: number; perPage: number; total: number; totalPages: number };
  campaignType: "nominative_postal" | "door_drop" | "digital";
}

export interface CampaignExportJob {
  id: string;
  orgId: string;
  campaignId: string;
  mode: "door_drop" | "nominative";
  status: "pending" | "processing" | "completed" | "failed";
  progressTotal: number;
  progressDone: number;
  progressPct: number;
  archiveS3Path: string | null;
  downloadUrl?: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapCampaign(raw: Campaign): Campaign {
  return {
    id: raw.id,
    orgId: raw.orgId,
    name: raw.name,
    type: raw.type,
    status: raw.status,
    defaultCurrency: raw.defaultCurrency,
    parentId: raw.parentId,
    operationalCostCents: raw.operationalCostCents,
    platformFeesCents: raw.platformFeesCents,
    goalAmountCents: raw.goalAmountCents,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

function toRequestBody(input: CampaignCreateInput | CampaignUpdateInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const maybeStatus = input as CampaignUpdateInput;

  if (input.name !== undefined) body.name = input.name;
  if (input.type !== undefined) body.type = input.type;
  if (input.defaultCurrency !== undefined) body.defaultCurrency = input.defaultCurrency;
  if (maybeStatus.status !== undefined) body.status = maybeStatus.status;
  if (input.parentId !== undefined) body.parentId = input.parentId;
  if (input.operationalCostCents !== undefined) {
    body.operationalCostCents = input.operationalCostCents;
  }
  if (input.goalAmountCents !== undefined) {
    body.goalAmountCents = input.goalAmountCents;
  }
  if (input.fundIds !== undefined) body.fundIds = input.fundIds;

  return body;
}
