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

export interface ConstituentCreateInput {
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  type?: string;
  tags?: string[];
}

export type ConstituentUpdateInput = Partial<ConstituentCreateInput>;

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

  /**
   * Create a new constituent. The API returns 409 with a `duplicates`
   * extension when a potential duplicate is detected; pass `force=true`
   * to bypass the duplicate check.
   */
  async createConstituent(
    client: ApiClient,
    input: ConstituentCreateInput,
    options: { force?: boolean } = {},
  ): Promise<Constituent> {
    const body = toRequestBody(input);
    const params = options.force ? { force: true } : undefined;
    const response = await client.post<ConstituentDetailResponse>("/v1/constituents", body, {
      params,
    });
    return mapConstituent(response.data);
  },

  /**
   * Update an existing constituent. Only non-empty fields are sent so
   * partial updates don't clobber stored values with empty strings.
   */
  async updateConstituent(
    client: ApiClient,
    id: string,
    input: ConstituentUpdateInput,
  ): Promise<Constituent> {
    const body = toRequestBody(input);
    const response = await client.put<ConstituentDetailResponse>(
      `/v1/constituents/${encodeURIComponent(id)}`,
      body,
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

/**
 * Normalize a form payload for the API: drop empty strings so optional
 * fields don't fail the API's `minLength`/`format` constraints.
 */
function toRequestBody(input: ConstituentUpdateInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.firstName !== undefined) body.firstName = input.firstName;
  if (input.lastName !== undefined) body.lastName = input.lastName;
  if (input.email !== undefined && input.email !== null && input.email !== "") {
    body.email = input.email;
  }
  if (input.phone !== undefined && input.phone !== null && input.phone !== "") {
    body.phone = input.phone;
  }
  if (input.type !== undefined) body.type = input.type;
  if (input.tags !== undefined) body.tags = input.tags;
  return body;
}
