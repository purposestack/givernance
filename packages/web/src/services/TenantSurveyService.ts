/**
 * Tenant-user survey service (issue #444).
 *
 * Powers the in-app survey modal: lists pending invitations, submits
 * responses, lets the user dismiss. Distinct from
 * `SuperAdminFinanceService` because the auth boundary is different —
 * these endpoints are gated on `requireAuth` (any tenant user), not
 * `requireSuperAdmin`.
 *
 * Endpoints exposed:
 *   - GET  /v1/surveys/pending             — list actionable in-app invites
 *   - POST /v1/surveys/:invitationId/respond — submit a response
 *   - POST /v1/surveys/:invitationId/dismiss — mark the modal closed
 */

import type { ApiClient } from "@/lib/api";
import type {
  PendingSurveyInvitation,
  PendingSurveyResponse,
  SurveyDismissResponse,
  SurveyRespondApiResponse,
  SurveyRespondPayload,
} from "@/models/surveys";

export const TenantSurveyService = {
  async fetchPending(client: ApiClient): Promise<PendingSurveyInvitation[]> {
    const response = await client.get<PendingSurveyResponse>("/v1/surveys/pending");
    return response.data;
  },

  async respond(
    client: ApiClient,
    invitationId: string,
    body: SurveyRespondPayload,
  ): Promise<SurveyRespondApiResponse["data"]> {
    const response = await client.post<SurveyRespondApiResponse>(
      `/v1/surveys/${encodeURIComponent(invitationId)}/respond`,
      body,
    );
    return response.data;
  },

  async dismiss(client: ApiClient, invitationId: string): Promise<SurveyDismissResponse["data"]> {
    const response = await client.post<SurveyDismissResponse>(
      `/v1/surveys/${encodeURIComponent(invitationId)}/dismiss`,
      {},
    );
    return response.data;
  },
};
