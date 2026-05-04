/**
 * PostalCampaignService — frontend bindings for the postal-campaign endpoints
 * added by Epic #274 (campaign membership, postal exports, QR stats, preview).
 *
 * Same pattern as the other Service modules (ADR-011 Layer 2): thin adapter
 * over the typed ApiClient that maps responses to the frontend models below.
 */

import type { ApiClient } from "@/lib/api";

export type PostalExportMode = "door_drop" | "personalized";
export type PostalExportStatus = "pending" | "processing" | "completed" | "failed";

export interface CampaignMember {
  id: string;
  constituentId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  type: string;
  addedAt: string;
  campaignDonationCents: number;
}

export interface CampaignMemberPagination {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

export interface PostalExport {
  id: string;
  campaignId: string;
  mode: PostalExportMode;
  status: PostalExportStatus;
  totalCount: number;
  progressCount: number;
  zipS3Path: string | null;
  error: string | null;
  requestedBy: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface CampaignQrStats {
  campaignId: string;
  totalCodes: number;
  scannedCodes: number;
  qrAttributedDonations: number;
  qrAttributedAmountCents: number;
}

export const PostalCampaignService = {
  // ── Membership ───────────────────────────────────────────────────

  async listMembers(
    client: ApiClient,
    campaignId: string,
    query: { page?: number; perPage?: number } = {},
  ): Promise<{ data: CampaignMember[]; pagination: CampaignMemberPagination }> {
    return client.get<{ data: CampaignMember[]; pagination: CampaignMemberPagination }>(
      `/v1/campaigns/${encodeURIComponent(campaignId)}/constituents`,
      { params: { page: query.page, perPage: query.perPage } },
    );
  },

  async addMembers(
    client: ApiClient,
    campaignId: string,
    constituentIds: string[],
  ): Promise<{ added: number; skipped: number }> {
    const response = await client.post<{ data: { added: number; skipped: number } }>(
      `/v1/campaigns/${encodeURIComponent(campaignId)}/constituents`,
      { constituentIds },
    );
    return response.data;
  },

  async removeMember(
    client: ApiClient,
    campaignId: string,
    constituentId: string,
  ): Promise<{ removed: boolean }> {
    const response = await client.delete<{ data: { removed: boolean } }>(
      `/v1/campaigns/${encodeURIComponent(campaignId)}/constituents/${encodeURIComponent(constituentId)}`,
    );
    return response.data;
  },

  // ── Postal exports ───────────────────────────────────────────────

  async listExports(client: ApiClient, campaignId: string): Promise<PostalExport[]> {
    const response = await client.get<{ data: PostalExport[] }>(
      `/v1/campaigns/${encodeURIComponent(campaignId)}/postal-exports`,
    );
    return response.data;
  },

  async startExport(
    client: ApiClient,
    campaignId: string,
    mode: PostalExportMode,
  ): Promise<PostalExport> {
    const response = await client.post<{ data: PostalExport }>(
      `/v1/campaigns/${encodeURIComponent(campaignId)}/postal-exports`,
      { mode },
    );
    return response.data;
  },

  async getExport(client: ApiClient, campaignId: string, exportId: string): Promise<PostalExport> {
    const response = await client.get<{ data: PostalExport }>(
      `/v1/campaigns/${encodeURIComponent(campaignId)}/postal-exports/${encodeURIComponent(exportId)}`,
    );
    return response.data;
  },

  /** Build the ZIP download URL — relative so it goes through the BFF / API proxy. */
  exportDownloadUrl(campaignId: string, exportId: string): string {
    return `/api/v1/campaigns/${encodeURIComponent(campaignId)}/postal-exports/${encodeURIComponent(exportId)}/download`;
  },

  /**
   * Build a preview-PDF POST URL — the frontend opens this in a new tab via a
   * form submission so the browser handles the resulting `application/pdf`
   * stream natively (instead of forcing us to load the whole binary into JS
   * memory). Relative path goes through the API proxy / cookie domain.
   */
  previewPdfUrl(campaignId: string): string {
    return `/api/v1/campaigns/${encodeURIComponent(campaignId)}/postal-preview`;
  },

  // ── QR stats ─────────────────────────────────────────────────────

  async getQrStats(client: ApiClient, campaignId: string): Promise<CampaignQrStats> {
    const response = await client.get<{ data: CampaignQrStats }>(
      `/v1/campaigns/${encodeURIComponent(campaignId)}/qr-stats`,
    );
    return response.data;
  },
};
