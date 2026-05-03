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

  // Post-callback redirect target (issue #250 step-up). Pulled before
  // cleanup runs; re-validated via the same allow-list as the login
  // route writes against — a stale or tampered cookie falls back to the
  // default landing page rather than becoming an open-redirect oracle.
  const rawReturnToCookie = jar.get(OIDC_RETURN_TO_COOKIE)?.value ?? null;
  const returnTo = safeReturnToPath(rawReturnToCookie);
  if (rawReturnToCookie && !returnTo) {
    // Defence-in-depth log: the login route already validates inbound
    // `return_to`, but a tampered cookie or a cross-deploy session that
    // crossed an APP_URL change would surface here. Same shape as the
    // login-route rejection so SOC dashboards can correlate.
    logAuthEvent("warn", "auth.return_to.rejected", {
      raw: rawReturnToCookie.slice(0, 256),
      reason: "cookie_not_same_origin_path",
    });
  }

  // Clean up OIDC flow cookies regardless of outcome
  const cleanup = () => {
    jar.delete(OIDC_STATE_COOKIE);
    jar.delete(OIDC_VERIFIER_COOKIE);
    jar.delete(OIDC_NONCE_COOKIE);
    jar.delete(OIDC_RETURN_TO_COOKIE);
  };

  // Keycloak returned an error — map to safe error code, never reflect raw text
  if (error) {
    cleanup();
    const loginUrl = new URL("/login", APP_URL);
    loginUrl.searchParams.set("error", sanitizeError(error));
    return NextResponse.redirect(loginUrl.toString());
  }

  // Validate state parameter — prevents CSRF login attacks
  const storedState = jar.get(OIDC_STATE_COOKIE)?.value;
  if (!state || !storedState || state !== storedState) {
    cleanup();
    const loginUrl = new URL("/login", APP_URL);
    loginUrl.searchParams.set("error", "invalid_state");
    return NextResponse.redirect(loginUrl.toString());
  }

  // No authorization code — something went wrong
  if (!code) {
    cleanup();
    return NextResponse.redirect(new URL("/login", APP_URL).toString());
  }

  // Retrieve PKCE code_verifier for token exchange
  const codeVerifier = jar.get(OIDC_VERIFIER_COOKIE)?.value;
  if (!codeVerifier) {
    cleanup();
    const loginUrl = new URL("/login", APP_URL);
    loginUrl.searchParams.set("error", "missing_verifier");
    return NextResponse.redirect(loginUrl.toString());
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
      cleanup();
      const loginUrl = new URL("/login", APP_URL);
      loginUrl.searchParams.set("error", "token_exchange_failed");
      return NextResponse.redirect(loginUrl.toString());
    }

    const tokens = (await tokenRes.json()) as {
      access_token: string;
      id_token?: string;
      refresh_token?: string;
      expires_in?: number;
      refresh_expires_in?: number;
    };

    try {
      await verifyKeycloakJwt(tokens.access_token);
    } catch (error) {
      logAuthEvent("error", "auth.callback.access_token_invalid", {
        message: error instanceof Error ? error.message : String(error).slice(0, 256),
      });
      cleanup();
      const loginUrl = new URL("/login", APP_URL);
      const errorCode =
        error instanceof Error && error.message.includes("`org_id`")
          ? "missing_org_id"
          : "callback_failed";
      loginUrl.searchParams.set("error", errorCode);
      return NextResponse.redirect(loginUrl.toString());
    }

    const sessionMaxAge = resolveSessionMaxAge(tokens);

    // Clean up OIDC flow cookies and store the verified Keycloak access token directly.
    cleanup();
    jar.set(JWT_COOKIE_NAME, tokens.access_token, jwtCookieOptions(sessionMaxAge));
    jar.set(getCsrfCookieName(), crypto.randomUUID(), buildCsrfCookieOptions(sessionMaxAge));
    if (tokens.id_token) {
      jar.set(ID_TOKEN_COOKIE_NAME, tokens.id_token, jwtCookieOptions(sessionMaxAge));
    }
    if (tokens.refresh_token) {
      jar.set(REFRESH_TOKEN_COOKIE_NAME, tokens.refresh_token, jwtCookieOptions(sessionMaxAge));
    }

    // Step-up MFA flow (issue #250): if the operator was redirected here
    // mid-task (e.g. from POST /v1/admin/impersonation 401), drop them
    // back where they were instead of routing through the org picker.
    // Falls through to the default landing page when no return_to is set.
    if (returnTo) {
      return NextResponse.redirect(new URL(returnTo, APP_URL).toString());
    }

    // FE-2: send every newly-authenticated user through `/select-organization`.
    // That page server-renders the membership fetch and will 302 to
    // `/dashboard` immediately if the user belongs to <=1 tenant — so solo-
    // tenant users pay one extra redirect (cheap) and multi-tenant users get
    // the picker without the callback blocking on a sequential fetch.
    return NextResponse.redirect(new URL("/select-organization", APP_URL).toString());
  } catch (err) {
    logAuthEvent("error", "auth.callback.unexpected_failure", {
      message: err instanceof Error ? err.message : String(err).slice(0, 256),
    });
    cleanup();
    const loginUrl = new URL("/login", APP_URL);
    loginUrl.searchParams.set("error", "callback_failed");
    return NextResponse.redirect(loginUrl.toString());
  }
}
