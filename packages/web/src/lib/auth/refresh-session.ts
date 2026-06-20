import "server-only";

import {
  KEYCLOAK_CLIENT_ID,
  requireClientSecret,
  resolveSessionMaxAge,
  TOKEN_ENDPOINT,
} from "./keycloak";

export interface RefreshedSession {
  accessToken: string;
  idToken?: string;
  refreshToken?: string;
  sessionMaxAge: number;
}

/**
 * Exchange a Keycloak `refresh_token` for a fresh token set.
 *
 * Shared by `/api/auth/restore-session` (full-page silent refresh + the
 * post-impersonation recovery navigation). Returns `null` on any failure
 * — no refresh token issued back, Keycloak `invalid_grant` (session
 * revoked / refresh expired), network blip, or a malformed 200 with no
 * `access_token`. Callers decide what a `null` means for cookie state.
 *
 * Extracted out of the proxy (issue #296): the Next.js proxy no longer
 * performs token refresh inline, so the one remaining server-side
 * refresh path lives here in a plain Node module (free to use
 * `server-only` + the keycloak config) rather than in the proxy runtime.
 */
export async function exchangeRefreshToken(refreshToken: string): Promise<RefreshedSession | null> {
  let response: Response;
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: KEYCLOAK_CLIENT_ID,
        client_secret: requireClientSecret(),
        refresh_token: refreshToken,
      }),
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  let tokens: {
    access_token?: string;
    id_token?: string;
    refresh_token?: string;
    expires_in?: number;
    refresh_expires_in?: number;
  };
  try {
    tokens = await response.json();
  } catch {
    return null;
  }

  if (!tokens.access_token) return null;

  return {
    accessToken: tokens.access_token,
    idToken: tokens.id_token,
    refreshToken: tokens.refresh_token,
    sessionMaxAge: resolveSessionMaxAge(tokens),
  };
}
