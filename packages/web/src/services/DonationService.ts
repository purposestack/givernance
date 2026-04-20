import type { ApiClient } from "@/lib/api";
import type { DonationListQuery, DonationListResponse, DonationListRow } from "@/models/donation";

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
