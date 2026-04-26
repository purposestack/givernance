import type { ApiClient } from "@/lib/api";
import type {
  Invitation,
  InvitationCreateInput,
  InvitationCreateResponse,
  InvitationListQuery,
  InvitationListResponse,
} from "@/models/invitation";

/**
 * InvitationService — ADR-011 Layer 2 (services).
 *
 * Wraps the authenticated team-invitation API for the org_admin "Members"
 * settings page. The public accept endpoint (`/v1/invitations/:token/accept`)
 * is unauthenticated and ships in a separate browser-side service —
 * `acceptInvitation` below — so we don't have to mix cookie-bearing and
 * cookieless requests on the same client instance.
 */
export const InvitationService = {
  async listInvitations(
    client: ApiClient,
    query: InvitationListQuery = {},
  ): Promise<InvitationListResponse> {
    const params: Record<string, string | number | boolean | undefined> = {
      page: query.page,
      perPage: query.perPage,
    };
    return client.get<InvitationListResponse>("/v1/invitations", { params });
  },

  async createInvitation(client: ApiClient, input: InvitationCreateInput): Promise<Invitation> {
    const body: Record<string, unknown> = { email: input.email };
    if (input.role) body.role = input.role;
    const response = await client.post<InvitationCreateResponse>("/v1/invitations", body);
    // The create endpoint returns the row without a derived status; treat
    // it as pending — `acceptedAt` is null and `expiresAt` is in the future
    // by construction.
    return { ...response.data, status: "pending" };
  },

  async resendInvitation(client: ApiClient, id: string): Promise<void> {
    await client.post<void>(`/v1/invitations/${encodeURIComponent(id)}/resend`);
  },

  async revokeInvitation(client: ApiClient, id: string): Promise<void> {
    await client.delete<void>(`/v1/invitations/${encodeURIComponent(id)}`);
  },
};

// ─── Public accept endpoint — token = credential, no cookies ────────────────

const PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

/**
 * Side-effect-free probe for the /invite/accept page (PR #154 follow-up).
 *
 * Hits `GET /v1/invitations/:token/probe` which returns 204 if the token
 * is currently acceptable, 410 otherwise (anti-enumeration shape — every
 * failure mode is collapsed by the API). On a network error we fall
 * through to "valid" so the form still renders; the post-submit terminal
 * screen catches the bad-token case as a fallback.
 */
export type InvitationProbeResult = "valid" | "invalid" | "rate_limited";

export async function probeInvitation(token: string): Promise<InvitationProbeResult> {
  let res: Response;
  try {
    res = await fetch(`${PUBLIC_API_URL}/v1/invitations/${encodeURIComponent(token)}/probe`, {
      method: "GET",
      credentials: "omit",
      headers: { Accept: "application/json" },
    });
  } catch {
    // Network-side failure: don't block the form. The post-submit terminal
    // screen will catch a bad token if the user reaches that point.
    return "valid";
  }
  if (res.status === 204) return "valid";
  if (res.status === 429) return "rate_limited";
  return "invalid";
}

export interface AcceptInvitationSuccess {
  /** Tenant slug — drives the post-accept Keycloak login `?hint=` param. */
  slug: string;
}

export type AcceptInvitationResult =
  | { ok: true; data: AcceptInvitationSuccess }
  | { ok: false; status: number; detail?: string };

export async function acceptInvitation(
  token: string,
  firstName: string,
  lastName: string,
  password: string,
): Promise<AcceptInvitationResult> {
  let res: Response;
  try {
    // No `credentials: "include"` — accept is unauthenticated; the token
    // itself is the credential.
    res = await fetch(`${PUBLIC_API_URL}/v1/invitations/${encodeURIComponent(token)}/accept`, {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ firstName, lastName, password }),
    });
  } catch {
    return { ok: false, status: 0 };
  }

  if (res.status === 201) {
    const json = (await res.json()) as { data: AcceptInvitationSuccess };
    return { ok: true, data: json.data };
  }

  let detail: string | undefined;
  try {
    const problem = (await res.json()) as { detail?: string };
    detail = problem.detail;
  } catch {
    // no body
  }
  return { ok: false, status: res.status, detail };
}
