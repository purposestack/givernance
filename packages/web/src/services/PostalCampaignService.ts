/**
 * PostalCampaignService — frontend bindings for the postal-campaign endpoints
 * added by Epic #274 (campaign membership, postal exports, QR stats, preview).
 *
 * Same pattern as the other Service modules (ADR-011 Layer 2): thin adapter
 * over the typed ApiClient that maps responses to the frontend models below.
 */

import type { CustomFieldValues } from "@givernance/shared/custom-fields";
import type { FilterQuery as FilterBuilderQuery } from "@/components/constituents/filters/filter-types";
import type { ApiClient } from "@/lib/api";

export type CampaignMemberSortField = "name" | "type" | "addedAt";
export type CampaignMemberSortOrder = "asc" | "desc";

export type PostalExportMode = "door_drop" | "personalized";
/** Output format (project item #194221573): a ZIP of per-recipient PDFs, or one merged multi-page PDF. */
export type PostalExportFormat = "zip" | "merged_pdf";
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
  /**
   * Cross-domain projection (Epic #539 §6): the member's `showOnRelated ∧
   * ¬sensitive` constituent custom values. Recomputed server-side per
   * request; absent on older API builds — render defensively.
   */
  donorCustom?: CustomFieldValues;
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
  format: PostalExportFormat;
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

/**
 * Re-export of the advanced-filter `FilterQuery` (Epic #421). Lives in
 * `components/constituents/filters/filter-types` so the FilterBuilder UI
 * and the service share one shape on the wire.
 */
export type FilterQuery = FilterBuilderQuery;

export interface AddMembersResult {
  added: number;
  skipped: number;
}

export const PostalCampaignService = {
  // ── Membership ───────────────────────────────────────────────────

  async listMembers(
    client: ApiClient,
    campaignId: string,
    query: {
      page?: number;
      perPage?: number;
      sort?: CampaignMemberSortField;
      order?: CampaignMemberSortOrder;
    } = {},
  ): Promise<{ data: CampaignMember[]; pagination: CampaignMemberPagination }> {
    return client.get<{ data: CampaignMember[]; pagination: CampaignMemberPagination }>(
      `/v1/campaigns/${encodeURIComponent(campaignId)}/constituents`,
      {
        params: { page: query.page, perPage: query.perPage, sort: query.sort, order: query.order },
      },
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

  /** Detach EVERY constituent from the campaign (start over). Returns the count removed. */
  async clearMembers(client: ApiClient, campaignId: string): Promise<{ removed: number }> {
    const response = await client.delete<{ data: { removed: number } }>(
      `/v1/campaigns/${encodeURIComponent(campaignId)}/constituents`,
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
    format: PostalExportFormat = "zip",
  ): Promise<PostalExport> {
    const response = await client.post<{ data: PostalExport }>(
      `/v1/campaigns/${encodeURIComponent(campaignId)}/postal-exports`,
      { mode, format },
    );
    return response.data;
  },

  async getExport(client: ApiClient, campaignId: string, exportId: string): Promise<PostalExport> {
    const response = await client.get<{ data: PostalExport }>(
      `/v1/campaigns/${encodeURIComponent(campaignId)}/postal-exports/${encodeURIComponent(exportId)}`,
    );
    return response.data;
  },

  /**
   * Build the export download URL — relative so it goes through the BFF /
   * API proxy. The endpoint serves either a `.zip` or a `.pdf` (project
   * item #194221573) depending on the export's stored `format`; the API
   * sets the content-type + filename, so the browser saves the right file.
   */
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

  // ── Filter-based members ─────────────────────────────────────────

  /**
   * Execute an advanced filter and atomically add every matching constituent
   * to the campaign (Epic #421).
   *
   * Calls `POST /v1/campaigns/:id/members/filter` — a single round-trip that
   * resolves the query and the membership insert in one backend transaction,
   * which is what the route's 5-req/min rate limit is sized for. Do **not**
   * fan-out the filter via `POST /v1/constituents/filter` and then call
   * `addMembers` separately: that path was the source of the "filtered-0
   * must match UUID pattern" bug fixed in this PR.
   */
  async addMembersFromFilter(
    client: ApiClient,
    campaignId: string,
    filterQuery: FilterQuery,
  ): Promise<AddMembersResult> {
    const response = await client.post<{ data: AddMembersResult }>(
      `/v1/campaigns/${encodeURIComponent(campaignId)}/members/filter`,
      { query: filterQuery },
    );
    return response.data;
  },
};
