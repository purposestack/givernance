import type { ApiClient } from "@/lib/api";
import type {
  Member,
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
 */
export const MemberService = {
  async listMembers(client: ApiClient): Promise<Member[]> {
    const response = await client.get<MemberListResponse>("/v1/users");
    return response.data;
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
