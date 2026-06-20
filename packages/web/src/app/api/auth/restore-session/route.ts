import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { buildCsrfCookieOptions, getCsrfCookieName } from "@/lib/auth/csrf";
import {
  APP_URL,
  authScopedCookieOptions,
  deleteLegacyRootSessionCookies,
  ID_TOKEN_COOKIE_NAME,
  JWT_COOKIE_NAME,
  jwtCookieOptions,
  REFRESH_TOKEN_COOKIE_NAME,
  safeReturnToPath,
} from "@/lib/auth/keycloak";
import { logAuthEvent } from "@/lib/auth/log";
import { exchangeRefreshToken } from "@/lib/auth/refresh-session";

const DEFAULT_RETURN_PATH = "/dashboard";

/**
 * GET /api/auth/restore-session?return=<same-origin path>
 *
 * Server-side silent refresh for full-page navigations (issue #296).
 * Replaces the inline token refresh the Next.js proxy used to run on
 * every request — which is no longer possible now that `refresh_token`
 * is scoped to `/api/auth` and therefore not attached to page/API
 * requests. Two callers redirect here:
 *
 *   1. The proxy, when a protected page is hit with a missing or
 *      near-expiry `givernance_jwt`: restores the session before the page
 *      renders so the user isn't bounced to /login mid-session (the
 *      cold-tab / post-impersonation-end case the proxy used to cover).
 *   2. The browser API client's impersonation-expiry interceptor: after
 *      an impersonation token 401s, a full-page nav here restores the
 *      operator's platform-admin session from their still-valid Keycloak
 *      refresh token, then lands them on the session list.
 *
 * CSRF: like `/api/auth/refresh`, no double-submit token is required. The
 * refresh cookie is httpOnly, the only effect is rotating the caller's
 * own tokens, and the redirect target is validated same-origin via
 * `safeReturnToPath`, so this is not an open-redirect or a useful CSRF
 * sink. Responses are `no-store` so the navigation is never cached or
 * prefetched into an unexpected token rotation.
 *
 * On success: rotates access / id / refresh cookies (+ CSRF) and
 * 303-redirects to the validated `return` path. On any failure: clears
 * the session cookies and 303-redirects to /login, preserving `return`
 * as the post-login `redirect`.
 */
export async function GET(request: NextRequest) {
  const jar = await cookies();
  const returnTo =
    safeReturnToPath(request.nextUrl.searchParams.get("return")) ?? DEFAULT_RETURN_PATH;
  const refreshToken = jar.get(REFRESH_TOKEN_COOKIE_NAME)?.value;

  if (!refreshToken) {
    return clearAndRedirectToLogin(jar, returnTo);
  }

  const session = await exchangeRefreshToken(refreshToken);
  if (!session) {
    logAuthEvent("warn", "auth.restore.refresh_failed", { returnTo });
    return clearAndRedirectToLogin(jar, returnTo);
  }

  jar.set(JWT_COOKIE_NAME, session.accessToken, jwtCookieOptions(session.sessionMaxAge));
  // A lingering pre-#296 `Path=/` id/refresh copy is harmless on the success
  // path (RFC 6265 §5.4 reads the more-specific `/api/auth` cookie first) and
  // is expired on the next clear / logout / re-login. Not deleted here so a
  // refresh that omits a new refresh_token can't drop the scoped one.
  if (session.idToken) {
    jar.set(ID_TOKEN_COOKIE_NAME, session.idToken, authScopedCookieOptions(session.sessionMaxAge));
  }
  if (session.refreshToken) {
    jar.set(
      REFRESH_TOKEN_COOKIE_NAME,
      session.refreshToken,
      authScopedCookieOptions(session.sessionMaxAge),
    );
  }

  // Re-mint / preserve the CSRF double-submit cookie alongside the rotated
  // JWT, mirroring `/api/auth/refresh` (PR #360 Security m6): keep the
  // existing value if present so in-flight client reads stay consistent,
  // otherwise mint a fresh one.
  const csrfName = getCsrfCookieName();
  const existingCsrf = jar.get(csrfName)?.value;
  jar.set(
    csrfName,
    existingCsrf && existingCsrf.length > 0 ? existingCsrf : crypto.randomUUID(),
    buildCsrfCookieOptions(session.sessionMaxAge),
  );

  return noStore(NextResponse.redirect(new URL(returnTo, APP_URL), 303));
}

function clearAndRedirectToLogin(
  jar: Awaited<ReturnType<typeof cookies>>,
  returnTo: string,
): NextResponse {
  jar.delete(JWT_COOKIE_NAME);
  // id_token + refresh_token live at `Path=/api/auth` (issue #296); also
  // expire any legacy `Path=/` copies from a pre-#296 session.
  jar.delete({ name: ID_TOKEN_COOKIE_NAME, path: "/api/auth" });
  jar.delete({ name: REFRESH_TOKEN_COOKIE_NAME, path: "/api/auth" });
  deleteLegacyRootSessionCookies(jar);
  jar.delete(getCsrfCookieName());
  const loginUrl = new URL("/login", APP_URL);
  loginUrl.searchParams.set("redirect", returnTo);
  return noStore(NextResponse.redirect(loginUrl, 303));
}

function noStore(response: NextResponse): NextResponse {
  response.headers.set("cache-control", "no-store");
  return response;
}
