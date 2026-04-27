import type { ApiClient } from "@/lib/api";
import type { MeProfile, MeResponse, UpdateMeInput } from "@/models/user";

/**
 * UserService — ADR-011 Layer 2 (services).
 *
 * Wraps the authenticated `/v1/users/me` surface for the profile page +
 * any future personal-preference UI. The unauthenticated `/v1/users/me`
 * probe in `(auth)/invite/accept/page.tsx` deliberately does NOT use
 * this service — it has different credential semantics (no cookies) and
 * lives outside the authenticated app shell.
 */
export const UserService = {
  async getMe(client: ApiClient): Promise<MeProfile> {
    const response = await client.get<MeResponse>("/v1/users/me");
    return response.data;
  },

  /**
   * Update the caller's personal preferences. Currently only `locale` is
   * exposed; the API body shape will grow over time. Pass `locale: null`
   * to clear the override and inherit the tenant default (issue #153).
   */
  async updateMe(client: ApiClient, input: UpdateMeInput): Promise<MeProfile> {
    const response = await client.patch<MeResponse>("/v1/users/me", input);
    return response.data;
  },
};
