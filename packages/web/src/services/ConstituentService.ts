import type { ApiClient } from "@/lib/api";
import type {
  Constituent,
  ConstituentDetailResponse,
  ConstituentListQuery,
  ConstituentListResponse,
  ConstituentListRow,
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
  // Postal address fields (Epic #274 follow-up). All optional. `null`
  // on update means "clear this column"; `undefined` means "leave alone";
  // `string` sets it.
  addressLine1?: string | null;
  addressLine2?: string | null;
  postalCode?: string | null;
  city?: string | null;
  countryCode?: string | null;
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
      sort: query.sort,
      order: query.order,
      // Epic #274 — campaign + lastDonation + lifetime amount filters.
      campaignId: query.campaignId,
      lastDonationFrom: query.lastDonationFrom,
      lastDonationTo: query.lastDonationTo,
      minLifetimeAmountCents: query.minLifetimeAmountCents,
      maxLifetimeAmountCents: query.maxLifetimeAmountCents,
    };

    const response = await client.get<ConstituentListResponse>("/v1/constituents", { params });

    return {
      data: response.data.map(mapConstituentListRow),
      pagination: response.pagination,
    };
  },

  /**
   * Bulk-send a transactional email to a selection of constituents (Epic
   * #274). Returns the queued + skipped counts; the API's 202 response
   * means the dispatch is now in the outbox, not that mail has been sent.
   */
  async sendBulkEmail(
    client: ApiClient,
    input: {
      constituentIds: string[];
      subject: string;
      body: string;
    },
  ): Promise<{ queued: number; skippedNoEmail: number }> {
    const response = await client.post<{
      data: { queued: number; skippedNoEmail: number };
    }>("/v1/constituents/bulk-email", input);
    return response.data;
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

  /**
   * Soft-delete a constituent. The API returns the soft-deleted row
   * (with `deletedAt` populated). org_admin-only — surfaces 403 to non-
   * admins via `ApiProblem`.
   */
  async deleteConstituent(client: ApiClient, id: string): Promise<Constituent> {
    const response = await client.delete<ConstituentDetailResponse>(
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
    addressLine1: raw.addressLine1 ?? null,
    addressLine2: raw.addressLine2 ?? null,
    postalCode: raw.postalCode ?? null,
    city: raw.city ?? null,
    countryCode: raw.countryCode ?? null,
    type: raw.type,
    tags: raw.tags,
    deletedAt: raw.deletedAt,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

function mapConstituentListRow(raw: ConstituentListRow): ConstituentListRow {
  return {
    ...mapConstituent(raw),
    lastDonationAt: raw.lastDonationAt,
  };
}

/**
 * Normalize a form payload for the API.
 *
 * `undefined` → drop the field (= "leave alone" on update / "use default"
 * on create). `null` → send through as an explicit clear ("set this column
 * to NULL"). Empty strings are also dropped to avoid `minLength`/`format`
 * validator rejections — callers that want to clear a field MUST send
 * `null` explicitly, not `""`.
 */
function toRequestBody(input: ConstituentUpdateInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.firstName !== undefined) body.firstName = input.firstName;
  if (input.lastName !== undefined) body.lastName = input.lastName;
  if (input.email !== undefined && input.email !== "") {
    body.email = input.email; // string OR null — both flow through
  }
  if (input.phone !== undefined && input.phone !== "") {
    body.phone = input.phone; // string OR null — both flow through
  }
  // Postal address fields — same `undefined`/`""` ⇒ drop, `null` ⇒ clear,
  // non-empty string ⇒ set convention as email/phone above.
  if (input.addressLine1 !== undefined && input.addressLine1 !== "") {
    body.addressLine1 = input.addressLine1;
  }
  if (input.addressLine2 !== undefined && input.addressLine2 !== "") {
    body.addressLine2 = input.addressLine2;
  }
  if (input.postalCode !== undefined && input.postalCode !== "") {
    body.postalCode = input.postalCode;
  }
  if (input.city !== undefined && input.city !== "") {
    body.city = input.city;
  }
  if (input.countryCode !== undefined && input.countryCode !== "") {
    body.countryCode = input.countryCode;
  }
  if (input.type !== undefined) body.type = input.type;
  if (input.tags !== undefined) body.tags = input.tags;
  return body;
}
