import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { buildCsrfCookieOptions, getCsrfCookieName } from "@/lib/auth/csrf";
import {
  APP_URL,
  ID_TOKEN_COOKIE_NAME,
  JWT_COOKIE_NAME,
  jwtCookieOptions,
  KEYCLOAK_CLIENT_ID,
  OIDC_NONCE_COOKIE,
  OIDC_RETURN_TO_COOKIE,
  OIDC_STATE_COOKIE,
  OIDC_VERIFIER_COOKIE,
  REFRESH_TOKEN_COOKIE_NAME,
  requireClientSecret,
  resolveSessionMaxAge,
  safeReturnToPath,
  TOKEN_ENDPOINT,
} from "@/lib/auth/keycloak";
import { logAuthEvent } from "@/lib/auth/log";
import { verifyKeycloakJwt } from "@/lib/auth/verify-keycloak-jwt";

/** Map Keycloak errors to safe, fixed error codes — never reflect upstream error text. */
function sanitizeError(error: string): string {
  // Log the upstream error for diagnostics; only fixed codes are reflected in the URL.
  logAuthEvent("warn", "auth.callback.upstream_error", {
    upstreamError: error.slice(0, 256),
  });
  switch (error) {
    case "access_denied":
    case "login_required":
    case "interaction_required":
    case "invalid_scope":
    case "invalid_request":
    case "unauthorized_client":
    case "unsupported_response_type":
    case "server_error":
    case "temporarily_unavailable":
      return error;
    default:
      return "auth_error";
  }
}

/**
 * Reads + validates the `return_to` OIDC cookie. Returns the safe path
 * or null; logs a defence-in-depth warning if the cookie was set but
 * didn't pass the same-origin / allowlist check the login route writes
 * against. Pulled out of `GET` to keep the callback handler under the
 * cognitive-complexity threshold.
 */
function readValidatedReturnTo(jar: Awaited<ReturnType<typeof cookies>>): string | null {
  const rawReturnToCookie = jar.get(OIDC_RETURN_TO_COOKIE)?.value ?? null;
  const returnTo = safeReturnToPath(rawReturnToCookie);
  if (rawReturnToCookie && !returnTo) {
    logAuthEvent("warn", "auth.return_to.rejected", {
      raw: rawReturnToCookie.slice(0, 256),
      reason: "cookie_not_same_origin_path",
    });
  }
  return returnTo;
}

/**
 * Cleans up OIDC flow cookies and returns a redirect to `/login`,
 * optionally tagging an `error` query param. Pulled out of `GET` to
 * collapse the half-dozen `cleanup() + new URL + searchParams.set +
 * NextResponse.redirect` repetitions into one call site each.
 */
function loginRedirectAfterCleanup(
  jar: Awaited<ReturnType<typeof cookies>>,
  errorCode?: string,
): NextResponse {
  jar.delete(OIDC_STATE_COOKIE);
  jar.delete(OIDC_VERIFIER_COOKIE);
  jar.delete(OIDC_NONCE_COOKIE);
  jar.delete(OIDC_RETURN_TO_COOKIE);
  const loginUrl = new URL("/login", APP_URL);
  if (errorCode) loginUrl.searchParams.set("error", errorCode);
  return NextResponse.redirect(loginUrl.toString());
}

/**
 * Picks the post-callback landing URL. Three branches:
 *   - `returnTo` set (issue #250 step-up MFA): drop the operator back
 *     where they were before the redirect.
 *   - `super_admin` realm role: super-admins have no tenant membership
 *     (ADR-022) and `/select-organization` would 302 them to
 *     `/login?error=no_tenants` — send them to the back-office tenant
 *     list instead.
 *   - Otherwise: every newly-authenticated tenant user routes through
 *     `/select-organization` (FE-2), which 302s onward to `/dashboard`
 *     for solo-tenant users.
 * Pulled out of `GET` to keep the callback handler under the
 * cognitive-complexity threshold (extract-only, behavior unchanged).
 */
function selectPostLoginRedirect(returnTo: string | null, isSuperAdmin: boolean): string {
  if (returnTo) return new URL(returnTo, APP_URL).toString();
  if (isSuperAdmin) return new URL("/admin/tenants", APP_URL).toString();
  return new URL("/select-organization", APP_URL).toString();
}

/**
 * GET /api/auth/callback
 *
 * Keycloak redirects here after the user authenticates.
 *
 * Security:
 * - Validates `state` parameter against cookie to prevent CSRF login attacks
 * - Sends PKCE `code_verifier` in token exchange to prevent code interception
 * - Cleans up OIDC flow cookies after use
 * - Never reflects upstream error descriptions (XSS prevention)
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  const jar = await cookies();

  // Post-callback redirect target (issue #250 step-up). Re-validated via
  // the same allow-list as the login route writes against — a stale or
  // tampered cookie falls back to the default landing page rather than
  // becoming an open-redirect oracle.
  const returnTo = readValidatedReturnTo(jar);

  // Keycloak returned an error — map to safe error code, never reflect raw text
  if (error) {
    return loginRedirectAfterCleanup(jar, sanitizeError(error));
  }

  // Validate state parameter — prevents CSRF login attacks
  const storedState = jar.get(OIDC_STATE_COOKIE)?.value;
  if (!state || !storedState || state !== storedState) {
    return loginRedirectAfterCleanup(jar, "invalid_state");
  }

  // No authorization code — something went wrong
  if (!code) {
    return loginRedirectAfterCleanup(jar);
  }

  // Retrieve PKCE code_verifier for token exchange
  const codeVerifier = jar.get(OIDC_VERIFIER_COOKIE)?.value;
  if (!codeVerifier) {
    return loginRedirectAfterCleanup(jar, "missing_verifier");
  }

  try {
    // Exchange the authorization code for tokens with PKCE code_verifier
    const tokenRes = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: KEYCLOAK_CLIENT_ID,
        client_secret: requireClientSecret(),
        code,
        redirect_uri: `${APP_URL}/api/auth/callback`,
        code_verifier: codeVerifier,
      }),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      logAuthEvent("error", "auth.callback.token_exchange_failed", {
        status: tokenRes.status,
        upstream: text.slice(0, 256),
      });
      return loginRedirectAfterCleanup(jar, "token_exchange_failed");
    }

    const tokens = (await tokenRes.json()) as {
      access_token: string;
      id_token?: string;
      refresh_token?: string;
      expires_in?: number;
      refresh_expires_in?: number;
    };

    let decoded: Awaited<ReturnType<typeof verifyKeycloakJwt>>;
    try {
      decoded = await verifyKeycloakJwt(tokens.access_token);
    } catch (error) {
      logAuthEvent("error", "auth.callback.access_token_invalid", {
        message: error instanceof Error ? error.message : String(error).slice(0, 256),
      });
      const errorCode =
        error instanceof Error && error.message.includes("`org_id`")
          ? "missing_org_id"
          : "callback_failed";
      return loginRedirectAfterCleanup(jar, errorCode);
    }
    const isSuperAdmin = decoded.realm_access?.roles?.includes("super_admin") ?? false;

    const sessionMaxAge = resolveSessionMaxAge(tokens);

    // Inline cleanup of OIDC flow cookies (the success path can't reuse
    // `loginRedirectAfterCleanup` because it doesn't redirect to /login).
    jar.delete(OIDC_STATE_COOKIE);
    jar.delete(OIDC_VERIFIER_COOKIE);
    jar.delete(OIDC_NONCE_COOKIE);
    jar.delete(OIDC_RETURN_TO_COOKIE);
    jar.set(JWT_COOKIE_NAME, tokens.access_token, jwtCookieOptions(sessionMaxAge));
    jar.set(getCsrfCookieName(), crypto.randomUUID(), buildCsrfCookieOptions(sessionMaxAge));
    if (tokens.id_token) {
      jar.set(ID_TOKEN_COOKIE_NAME, tokens.id_token, jwtCookieOptions(sessionMaxAge));
    }
    if (tokens.refresh_token) {
      jar.set(REFRESH_TOKEN_COOKIE_NAME, tokens.refresh_token, jwtCookieOptions(sessionMaxAge));
    }

    return NextResponse.redirect(selectPostLoginRedirect(returnTo, isSuperAdmin));
  } catch (err) {
    logAuthEvent("error", "auth.callback.unexpected_failure", {
      message: err instanceof Error ? err.message : String(err).slice(0, 256),
    });
    return loginRedirectAfterCleanup(jar, "callback_failed");
  }
}
