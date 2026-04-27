import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import {
  APP_URL,
  AUTH_ENDPOINT,
  generateCodeChallenge,
  generateRandom,
  KEYCLOAK_CLIENT_ID,
  OIDC_NONCE_COOKIE,
  OIDC_STATE_COOKIE,
  OIDC_VERIFIER_COOKIE,
  oidcFlowCookieOptions,
} from "@/lib/auth/keycloak";

/**
 * Extracts the Keycloak Organization alias from the request Host header.
 *
 * Pattern 1 (subdomain-first): each tenant runs on its own subdomain
 * (e.g. asso-x.givernance.eu). The subdomain is used as the `kc_org`
 * hint so Keycloak applies the org's custom theme before the user even
 * types their credentials.
 *
 * Returns null for:
 * - localhost / single-part hostnames (local dev — no subdomain)
 * - known non-org subdomains: www, app, api, admin
 */
function extractOrgAlias(host: string): string | null {
  const hostname = host.split(":")[0] ?? ""; // strip port
  const parts = hostname.split(".");
  if (parts.length < 3) return null; // no subdomain

  const subdomain = parts[0] ?? "";
  if (!subdomain) return null;

  const NON_ORG = new Set(["www", "app", "api", "admin"]);
  if (NON_ORG.has(subdomain)) return null;

  return subdomain;
}

/**
 * GET /api/auth/login
 *
 * Redirects the browser to the Keycloak authorization endpoint to begin
 * the OIDC Authorization Code flow with PKCE (S256), state, and nonce.
 *
 * Security:
 * - `state` prevents CSRF login attacks (validated in callback)
 * - `code_verifier`/`code_challenge` (PKCE S256) prevents authorization code interception
 * - `nonce` binds the ID token to this specific authentication request
 * - All three values stored in httpOnly cookies for callback validation
 *
 * Theming (Pattern 1 — subdomain-first):
 * - Reads the Host / X-Forwarded-Host header to derive the org alias
 * - Passes `kc_org=<alias>` so Keycloak resolves the Organization and
 *   injects per-org CSS variables (theme_primary_color, logo_url) into
 *   the login page before the user authenticates.
 */
export async function GET(request: NextRequest) {
  const state = generateRandom();
  const nonce = generateRandom();
  const codeVerifier = generateRandom();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "";
  const orgAlias = extractOrgAlias(host);

  const params = new URLSearchParams({
    client_id: KEYCLOAK_CLIENT_ID,
    redirect_uri: `${APP_URL}/api/auth/callback`,
    response_type: "code",
    scope: "openid profile email",
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  // Pass the org alias so Keycloak applies per-org theming and scopes the
  // session to the correct Organization. No-op in local dev (no subdomain).
  if (orgAlias) {
    params.set("kc_org", orgAlias);
  }

  // Store OIDC flow params in httpOnly cookies for validation in callback
  const jar = await cookies();
  const opts = oidcFlowCookieOptions();
  jar.set(OIDC_STATE_COOKIE, state, opts);
  jar.set(OIDC_VERIFIER_COOKIE, codeVerifier, opts);
  jar.set(OIDC_NONCE_COOKIE, nonce, opts);

  return NextResponse.redirect(`${AUTH_ENDPOINT}?${params.toString()}`);
}
