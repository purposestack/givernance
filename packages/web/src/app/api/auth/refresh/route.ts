import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { buildCsrfCookieOptions, getCsrfCookieName } from "@/lib/auth/csrf";
import {
  authScopedCookieOptions,
  deleteLegacyRootSessionCookies,
  ID_TOKEN_COOKIE_NAME,
  JWT_COOKIE_NAME,
  jwtCookieOptions,
  KEYCLOAK_CLIENT_ID,
  REFRESH_TOKEN_COOKIE_NAME,
  requireClientSecret,
  resolveSessionMaxAge,
  TOKEN_ENDPOINT,
} from "@/lib/auth/keycloak";
import { logAuthEvent } from "@/lib/auth/log";

/**
 * POST /api/auth/refresh — silent access-token rotation (issue #76 / PR-3).
 *
 * The realm shortens `access.token.lifespan` to 300s so that the back-channel
 * logout blocklist (PR-2) only has to hold sids for a short window. To keep
 * users from being logged out every 5 minutes, the AuthProvider schedules a
 * silent refresh against this endpoint shortly before the access token
 * expires.
 *
 * Behaviour:
 *   - Reads the `givernance_refresh_token` cookie.
 *   - Calls Keycloak's token endpoint with `grant_type=refresh_token`.
 *   - On success: writes the new access / id / refresh tokens to their
 *     httpOnly cookies (refresh_token rotation: every Keycloak refresh
 *     returns a fresh refresh_token, the old one becomes invalid).
 *   - On any failure (no cookie, Keycloak 4xx, network blip): clears
 *     every session cookie and returns 401. The client AuthProvider
 *     treats 401 as "session is gone", redirects to /login.
 *
 * CSRF: refresh runs without the CSRF double-submit header because (a) the
 * client cannot read the refresh cookie (httpOnly), and (b) a CSRF-tricked
 * refresh achieves nothing useful for an attacker — it just rotates the
 * victim's own tokens. The bigger concern would be the response side-effect,
 * but the response goes to the same origin and the new cookies overwrite
 * the old ones in-place. No CSRF check needed; documented here so future
 * reviewers don't add one reflexively.
 */
export async function POST(_request: NextRequest) {
  const jar = await cookies();
  const refreshToken = jar.get(REFRESH_TOKEN_COOKIE_NAME)?.value;

  if (!refreshToken) {
    return clearAndReturn(jar, 401, "no_refresh_token");
  }

  let res: Response;
  try {
    res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: KEYCLOAK_CLIENT_ID,
        client_secret: requireClientSecret(),
        refresh_token: refreshToken,
      }),
    });
  } catch (err) {
    logAuthEvent("error", "auth.refresh.network_failure", {
      message: err instanceof Error ? err.message : String(err).slice(0, 256),
    });
    // Network blip — don't clear cookies; surface the failure so the
    // client can retry. The session is still potentially valid.
    return NextResponse.json(
      { error: "network_failure" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  if (!res.ok) {
    // Keycloak's `invalid_grant` covers: refresh token expired, refresh
    // token revoked (post-logout, back-channel sid revocation, admin
    // "Sign out all sessions"). All of those mean the session is gone —
    // clear the cookies and force the client back to /login.
    const text = await res.text().catch(() => "");
    logAuthEvent("warn", "auth.refresh.upstream_rejected", {
      status: res.status,
      upstream: text.slice(0, 256),
    });
    return clearAndReturn(jar, 401, "refresh_rejected");
  }

  const tokens = (await res.json()) as {
    access_token?: string;
    id_token?: string;
    refresh_token?: string;
    expires_in?: number;
    refresh_expires_in?: number;
  };

  if (!tokens.access_token) {
    // Keycloak returned 200 but no access_token — shouldn't happen, but
    // bail rather than persisting an empty cookie.
    logAuthEvent("error", "auth.refresh.malformed_response", {});
    return clearAndReturn(jar, 401, "malformed_response");
  }

  const sessionMaxAge = resolveSessionMaxAge(tokens);
  jar.set(JWT_COOKIE_NAME, tokens.access_token, jwtCookieOptions(sessionMaxAge));
  // Issue #296: id_token + refresh_token stay scoped to `/api/auth` (see
  // `authScopedCookieOptions`) so a rotated pair never starts leaking onto
  // API/page requests after a refresh. A lingering pre-#296 `Path=/` copy is
  // harmless here — RFC 6265 §5.4 sends the more-specific `/api/auth` cookie
  // first, so it's authoritative — and is expired on the next logout / clear
  // / re-login (callback). We deliberately don't delete it on the success
  // path so a refresh that omits a new refresh_token can't drop the scoped one.
  if (tokens.id_token) {
    jar.set(ID_TOKEN_COOKIE_NAME, tokens.id_token, authScopedCookieOptions(sessionMaxAge));
  }
  if (tokens.refresh_token) {
    jar.set(
      REFRESH_TOKEN_COOKIE_NAME,
      tokens.refresh_token,
      authScopedCookieOptions(sessionMaxAge),
    );
  }

  // PR #360 review (Security m6 + Architect m6): re-mint the CSRF
  // double-submit cookie alongside the rotated JWT. Two reasons:
  //   1. The CSRF cookie was set at callback time with the *original*
  //      session maxAge — after several refreshes the browser would
  //      drop it while the JWT keeps rotating, breaking every
  //      authenticated mutation with a 403 the user can't diagnose.
  //   2. If the original CSRF token leaked (e.g. XSS read at minute 1),
  //      refreshing without rotation hands the attacker a still-valid
  //      double-submit token paired with brand-new JWTs for the rest
  //      of the session ("XSS once → CSRF forever within session").
  // Preserve the existing value if present so in-flight reads on the
  // client side stay consistent across the rotation; only mint a fresh
  // value when there's nothing to preserve.
  const csrfCookieName = getCsrfCookieName();
  const existingCsrf = jar.get(csrfCookieName)?.value;
  jar.set(
    csrfCookieName,
    existingCsrf && existingCsrf.length > 0 ? existingCsrf : crypto.randomUUID(),
    buildCsrfCookieOptions(sessionMaxAge),
  );

  return NextResponse.json(
    { ok: true, expiresIn: tokens.expires_in ?? null },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}

function clearAndReturn(
  jar: Awaited<ReturnType<typeof cookies>>,
  status: number,
  reason: string,
): NextResponse {
  jar.delete(JWT_COOKIE_NAME);
  // id_token + refresh_token were set with `Path=/api/auth` (issue #296);
  // a `delete` only clears a cookie when its path matches, so target it.
  // Also expire any legacy `Path=/` copies from a pre-#296 session.
  jar.delete({ name: ID_TOKEN_COOKIE_NAME, path: "/api/auth" });
  jar.delete({ name: REFRESH_TOKEN_COOKIE_NAME, path: "/api/auth" });
  deleteLegacyRootSessionCookies(jar);
  jar.delete(getCsrfCookieName());
  return NextResponse.json({ error: reason }, { status, headers: { "cache-control": "no-store" } });
}
