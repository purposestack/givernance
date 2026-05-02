/**
 * Public-facing invitation accept service for platform admins (issue #254
 * fix-commit 4 refactor). Distinct from `PlatformAdminService.ts` which
 * targets the super-admin-gated CRUD; the endpoints here are publicly
 * reachable so an unauthenticated invitee can validate the token and
 * accept the invitation.
 *
 * No `ApiClient` dependency — these calls happen on a public page that
 * doesn't have the operator's CSRF token. We use `fetch` directly with
 * `credentials: include` so any pre-existing session cookie is sent
 * (the page detects "logged in as someone else" and prompts logout).
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

export interface PlatformAdminInvitationDetail {
  email: string;
  firstName: string;
  lastName: string;
  expiresAt: string;
}

export type ProbeResult =
  | { kind: "valid"; data: PlatformAdminInvitationDetail }
  | { kind: "invalid" };

export async function probePlatformAdminInvitation(token: string): Promise<ProbeResult> {
  try {
    const res = await fetch(
      `${API_URL}/v1/public/platform-admins/invitations/${encodeURIComponent(token)}`,
      { credentials: "include" },
    );
    if (!res.ok) return { kind: "invalid" };
    const body = (await res.json()) as { data?: PlatformAdminInvitationDetail };
    if (!body.data?.email) return { kind: "invalid" };
    return { kind: "valid", data: body.data };
  } catch {
    return { kind: "invalid" };
  }
}

export type AcceptResult = { ok: true } | { ok: false; status: number; detail: string | undefined };

export async function acceptPlatformAdminInvitation(
  token: string,
  firstName: string,
  lastName: string,
  password: string,
): Promise<AcceptResult> {
  try {
    const res = await fetch(
      `${API_URL}/v1/public/platform-admins/invitations/${encodeURIComponent(token)}/accept`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ firstName, lastName, password }),
      },
    );
    if (res.ok) return { ok: true };
    let detail: string | undefined;
    try {
      const body = (await res.json()) as { detail?: string };
      detail = body.detail;
    } catch {}
    return { ok: false, status: res.status, detail };
  } catch {
    return { ok: false, status: 0, detail: undefined };
  }
}
