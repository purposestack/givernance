import { cookies } from "next/headers";
import { NextResponse } from "next/server";
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
 */
export async function GET() {
  const state = generateRandom();
  const nonce = generateRandom();
  const codeVerifier = generateRandom();
  const codeChallenge = generateCodeChallenge(codeVerifier);

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

  // Store OIDC flow params in httpOnly cookies for validation in callback
  const jar = await cookies();
  const opts = oidcFlowCookieOptions();
  jar.set(OIDC_STATE_COOKIE, state, opts);
  jar.set(OIDC_VERIFIER_COOKIE, codeVerifier, opts);
  jar.set(OIDC_NONCE_COOKIE, nonce, opts);

  return NextResponse.redirect(`${AUTH_ENDPOINT}?${params.toString()}`);
}
