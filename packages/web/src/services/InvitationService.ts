import { APP_DEFAULT_LOCALE, isSupportedLocale, type Locale } from "@givernance/shared/i18n";
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
    // `null` is a meaningful value here ("admin chose tenant default") —
    // forward it explicitly. `undefined` is omitted from the request.
    if (input.locale !== undefined) body.locale = input.locale;
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
 * Hits `GET /v1/invitations/:token/probe`. Issue #153 changed the success
 * response from 204 to 200 with `{ defaultLocale }` so the accept form
 * can pre-select the right locale picker option without a second
 * round-trip. The follow-up shipped per-invitation locale (admin
 * pre-pick), so `defaultLocale` is now the *invitation-aware* default —
 * `invitation.locale ?? tenant.default_locale`. We still treat 204 as
 * valid for one transitional release in case a stale browser hits a
 * freshly-deployed API; the fallback is `APP_DEFAULT_LOCALE`.
 *
 * Anti-enumeration: 410 covers every failure mode (wrong token / accepted
 * / expired / wrong purpose) — collapsed by the API. On a network error
 * we render the form anyway; the post-submit terminal screen catches a
 * bad-token case as a fallback.
 */
export type InvitationProbeResult =
  | { kind: "valid"; defaultLocale: Locale }
  | { kind: "invalid" }
  | { kind: "rate_limited" };

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
    return { kind: "valid", defaultLocale: APP_DEFAULT_LOCALE };
  }
  if (res.status === 200) {
    try {
      const json = (await res.json()) as {
        data?: { defaultLocale?: unknown; tenantDefaultLocale?: unknown };
      };
      // Prefer the new field; fall back to the legacy `tenantDefaultLocale`
      // for one transitional release if a stale API is in flight.
      const candidate = json.data?.defaultLocale ?? json.data?.tenantDefaultLocale;
      const defaultLocale: Locale = isSupportedLocale(candidate) ? candidate : APP_DEFAULT_LOCALE;
      return { kind: "valid", defaultLocale };
    } catch {
      return { kind: "valid", defaultLocale: APP_DEFAULT_LOCALE };
    }
  }
  // 204 is the legacy shape — kept for transitional compat across deploy.
  if (res.status === 204) return { kind: "valid", defaultLocale: APP_DEFAULT_LOCALE };
  if (res.status === 429) return { kind: "rate_limited" };
  return { kind: "invalid" };
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
  locale: Locale | undefined,
): Promise<AcceptInvitationResult> {
  let res: Response;
  try {
    // No `credentials: "include"` — accept is unauthenticated; the token
    // itself is the credential.
    res = await fetch(`${PUBLIC_API_URL}/v1/invitations/${encodeURIComponent(token)}/accept`, {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ firstName, lastName, password, locale }),
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
