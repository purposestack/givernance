import type { ApiClient } from "@/lib/api";
import type {
  Constituent,
  ConstituentDetailResponse,
  ConstituentListQuery,
  ConstituentListResponse,
} from "@/models/constituent";

/**
 * ConstituentService — ADR-011 Layer 2 (services).
 *
 * Thin adapter over the typed ApiClient that maps HTTP responses to the
 * frontend Constituent model. Keeps transport concerns (URLs, query
 * param serialization) out of pages and components.
 */
export const ConstituentService = {
  /**
   * Fetch a paginated list of constituents for the current organization.
   * The API (Fastify) resolves the orgId from the JWT; the client only
   * needs to pass pagination and filters.
   */
  async listConstituents(
    client: ApiClient,
    query: ConstituentListQuery = {},
  ): Promise<ConstituentListResponse> {
    const params: Record<string, string | number | boolean | undefined> = {
      page: query.page,
      perPage: query.perPage,
      search: query.search || undefined,
      type: query.type,
    };

    const response = await client.get<ConstituentListResponse>("/v1/constituents", { params });

    return {
      data: response.data.map(mapConstituent),
      pagination: response.pagination,
    };
  },

  /**
   * Fetch a single constituent by ID. The API resolves the orgId from the
   * JWT and returns 404 when the constituent belongs to another tenant.
   */
  async getConstituent(client: ApiClient, id: string): Promise<Constituent> {
    const response = await client.get<ConstituentDetailResponse>(
      `/v1/constituents/${encodeURIComponent(id)}`,
    );
    return mapConstituent(response.data);
  },
};

function mapConstituent(raw: Constituent): Constituent {
  return {
    id: raw.id,
    orgId: raw.orgId,
    firstName: raw.firstName,
    lastName: raw.lastName,
    email: raw.email,
    phone: raw.phone,
    type: raw.type,
    tags: raw.tags,
    deletedAt: raw.deletedAt,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}
