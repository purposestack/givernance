import type { ApiClient } from "@/lib/api";
import type {
  Member,
  MemberListQuery,
  MemberListResponse,
  UpdateMemberInput,
  UpdateMemberResponse,
} from "@/models/member";

/**
 * MemberService — ADR-011 Layer 2 (services).
 *
 * Wraps `GET /v1/users` and `PATCH /v1/users/:id` for the org_admin members
 * settings page. The DELETE path lives here too so the existing
 * "remove member" affordance keeps a single service per resource.
 *
 * Issue #161 — replaces the role-only `PATCH /v1/users/:id/role` with a
 * combined endpoint accepting `{ firstName?, lastName?, role? }`.
 * PR #185 review PJD-6 — `listMembers` is now paginated to scale to
 * orgs with hundreds of staff.
 */
export const MemberService = {
  async listMembers(client: ApiClient, query: MemberListQuery = {}): Promise<MemberListResponse> {
    const params: Record<string, string | number | boolean | undefined> = {
      page: query.page,
      perPage: query.perPage,
    };
    return client.get<MemberListResponse>("/v1/users", { params });
  },

  async updateMember(client: ApiClient, id: string, input: UpdateMemberInput): Promise<Member> {
    const body: Record<string, unknown> = {};
    if (input.firstName !== undefined) body.firstName = input.firstName;
    if (input.lastName !== undefined) body.lastName = input.lastName;
    if (input.role !== undefined) body.role = input.role;
    const response = await client.patch<UpdateMemberResponse>(
      `/v1/users/${encodeURIComponent(id)}`,
      body,
    );
    return response.data;
  },

  async removeMember(client: ApiClient, id: string): Promise<void> {
    await client.delete<void>(`/v1/users/${encodeURIComponent(id)}`);
  },
};
