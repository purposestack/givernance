/**
 * PlatformAdminService — ADR-011 Layer 2 (services).
 *
 * Wraps `/v1/admin/platform-admins` (issue #254). Super-admin only;
 * non-super-admins receive 404 (anti-disclosure) at the API. Errors are
 * RFC 9457 ProblemDetails; the call sites map `status` to a user-facing
 * toast / inline form-error message.
 */

import type { ApiClient } from "@/lib/api";
import type {
  CreatePlatformAdminInput,
  PlatformAdmin,
  PlatformAdminDetailResponse,
  PlatformAdminListQuery,
  PlatformAdminListResponse,
  UpdatePlatformAdminInput,
} from "@/models/platform-admin";

export const PlatformAdminService = {
  async list(
    client: ApiClient,
    query: PlatformAdminListQuery = {},
  ): Promise<PlatformAdminListResponse> {
    const params: Record<string, string | number | boolean | undefined> = {
      q: query.q,
      includeDeleted: query.includeDeleted,
      sort: query.sort,
      order: query.order,
      limit: query.limit,
      offset: query.offset,
    };
    return client.get<PlatformAdminListResponse>("/v1/admin/platform-admins", { params });
  },

  async getById(client: ApiClient, id: string): Promise<PlatformAdmin> {
    const res = await client.get<PlatformAdminDetailResponse>(
      `/v1/admin/platform-admins/${encodeURIComponent(id)}`,
    );
    return res.data;
  },

  async create(client: ApiClient, input: CreatePlatformAdminInput): Promise<PlatformAdmin> {
    const res = await client.post<PlatformAdminDetailResponse>("/v1/admin/platform-admins", input);
    return res.data;
  },

  async updateName(
    client: ApiClient,
    id: string,
    input: UpdatePlatformAdminInput,
  ): Promise<PlatformAdmin> {
    const res = await client.patch<PlatformAdminDetailResponse>(
      `/v1/admin/platform-admins/${encodeURIComponent(id)}`,
      input,
    );
    return res.data;
  },

  async resetPassword(client: ApiClient, id: string): Promise<void> {
    await client.post<void>(`/v1/admin/platform-admins/${encodeURIComponent(id)}/reset-password`);
  },

  async remove(client: ApiClient, id: string): Promise<void> {
    await client.delete<void>(`/v1/admin/platform-admins/${encodeURIComponent(id)}`);
  },
};
