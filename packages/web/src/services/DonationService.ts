import type { ApiClient } from "@/lib/api";
import type {
  Donation,
  DonationCreateInput,
  DonationDetail,
  DonationDetailResponse,
  DonationListQuery,
  DonationListResponse,
  DonationListRow,
  DonationReceiptUrl,
  DonationUpdateInput,
} from "@/models/donation";

/**
 * DonationService — ADR-011 Layer 2 (services).
 *
 * Thin adapter over the typed ApiClient that maps HTTP responses to the
 * frontend Donation model. The API (Fastify) resolves the orgId from the
 * JWT; callers only pass pagination and filters.
 */
export const DonationService = {
  async listDonations(
    client: ApiClient,
    query: DonationListQuery = {},
  ): Promise<DonationListResponse> {
    const params: Record<string, string | number | boolean | undefined> = {
      page: query.page,
      perPage: query.perPage,
      constituentId: query.constituentId,
      campaignId: query.campaignId,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      amountMin: query.amountMin,
      amountMax: query.amountMax,
    };

    const response = await client.get<DonationListResponse>("/v1/donations", { params });

    return {
      data: response.data.map(mapDonationRow),
      pagination: response.pagination,
    };
  },

  async getDonation(client: ApiClient, id: string): Promise<DonationDetail> {
    const response = await client.get<DonationDetailResponse>(
      `/v1/donations/${encodeURIComponent(id)}`,
    );
    return response.data;
  },

  async createDonation(client: ApiClient, input: DonationCreateInput): Promise<Donation> {
    const response = await client.post<{ data: Donation }>("/v1/donations", toRequestBody(input));
    return response.data;
  },

  async updateDonation(
    client: ApiClient,
    id: string,
    input: DonationUpdateInput,
  ): Promise<Donation> {
    const response = await client.patch<{ data: Donation }>(
      `/v1/donations/${encodeURIComponent(id)}`,
      toUpdateRequestBody(input),
    );
    return response.data;
  },

  async deleteDonation(client: ApiClient, id: string): Promise<Donation> {
    const response = await client.delete<{ data: Donation }>(
      `/v1/donations/${encodeURIComponent(id)}`,
    );
    return response.data;
  },

  async getDonationReceiptUrl(client: ApiClient, id: string): Promise<string> {
    const response = await client.get<{ data: DonationReceiptUrl }>(
      `/v1/donations/${encodeURIComponent(id)}/receipt`,
    );
    return response.data.url;
  },
};

function mapDonationRow(raw: DonationListRow): DonationListRow {
  return {
    id: raw.id,
    orgId: raw.orgId,
    constituentId: raw.constituentId,
    amountCents: raw.amountCents,
    currency: raw.currency,
    campaignId: raw.campaignId,
    paymentMethod: raw.paymentMethod,
    paymentRef: raw.paymentRef,
    donatedAt: raw.donatedAt,
    fiscalYear: raw.fiscalYear,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    constituent: raw.constituent
      ? { firstName: raw.constituent.firstName, lastName: raw.constituent.lastName }
      : null,
    receiptStatus: raw.receiptStatus,
  };
}

/**
 * Normalize the form payload for the API: drop empty-string optionals so
 * they don't fail the API's `minLength`/`format` constraints, and omit an
 * empty allocations list so the server treats the donation as unallocated.
 */
function toRequestBody(input: DonationCreateInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    constituentId: input.constituentId,
    amountCents: input.amountCents,
  };
  if (input.currency) body.currency = input.currency;
  if (input.campaignId) body.campaignId = input.campaignId;
  if (input.paymentMethod) body.paymentMethod = input.paymentMethod;
  if (input.paymentRef) body.paymentRef = input.paymentRef;
  if (input.donatedAt) body.donatedAt = input.donatedAt;
  if (input.fiscalYear !== undefined && input.fiscalYear !== null) {
    body.fiscalYear = input.fiscalYear;
  }
  if (input.allocations && input.allocations.length > 0) {
    body.allocations = input.allocations;
  }
  return body;
}

function toUpdateRequestBody(input: DonationUpdateInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    constituentId: input.constituentId,
    amountCents: input.amountCents,
  };

  if (input.currency) body.currency = input.currency;
  body.campaignId = input.campaignId ?? null;
  body.paymentMethod = input.paymentMethod ?? null;
  body.paymentRef = input.paymentRef ?? null;
  if (input.donatedAt) body.donatedAt = input.donatedAt;
  if (input.fiscalYear !== undefined) body.fiscalYear = input.fiscalYear;
  body.allocations = input.allocations ?? [];

  return body;
}
