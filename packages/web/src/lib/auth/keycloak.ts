import "server-only";

import { createHash, randomBytes } from "node:crypto";

/**
 * Keycloak OIDC configuration — centralised for all auth API routes.
 * Environment variables follow ADR-011 naming: server-only vars have no NEXT_PUBLIC_ prefix.
 */

export const KEYCLOAK_URL = process.env.KEYCLOAK_URL ?? "http://localhost:8080";
export const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM ?? "givernance";
export const KEYCLOAK_CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID ?? "givernance-web";
export const KEYCLOAK_ISSUER =
  process.env.KEYCLOAK_ISSUER ?? `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}`;
export const KEYCLOAK_JWKS_URL =
  process.env.KEYCLOAK_JWKS_URL ?? `${KEYCLOAK_ISSUER}/protocol/openid-connect/certs`;
export const KEYCLOAK_CLIENT_SECRET =
  process.env.KEYCLOAK_CLIENT_SECRET ||
  process.env.NEXT_PUBLIC_KEYCLOAK_CLIENT_SECRET ||
  "ci-test-secret-do-not-use-in-production";
export const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

/**
 * Validate that KEYCLOAK_CLIENT_SECRET is set. Call this at runtime in
 * route handlers that need the secret — not at module scope, because
 * `next build` sets NODE_ENV=production and would fail during static analysis.
 */
export function requireClientSecret(): string {
  if (!KEYCLOAK_CLIENT_SECRET) {
    throw new Error("KEYCLOAK_CLIENT_SECRET environment variable is required");
  }
  return KEYCLOAK_CLIENT_SECRET;
}

/** Keycloak OpenID Connect endpoints. */
export const AUTH_ENDPOINT = `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/auth`;
export const TOKEN_ENDPOINT = `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`;
export const LOGOUT_ENDPOINT = `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/logout`;

/** JWT cookie name — consistent across middleware, layout, and API routes. */
export const JWT_COOKIE_NAME = "givernance_jwt";

/**
 * ID token cookie — needed as `id_token_hint` on the Keycloak end-session
 * endpoint so logout is silent (no "Are you sure?" prompt).
 */
export const ID_TOKEN_COOKIE_NAME = "givernance_id_token";

/** Max age for the JWT cookie — 8 hours (matches typical Keycloak session). */
export const COOKIE_MAX_AGE_S = 8 * 60 * 60;

/** Cookie attributes for the JWT — httpOnly + Secure + SameSite=Strict per ADR-011. */
export function jwtCookieOptions(maxAge?: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict" as const,
    path: "/",
    maxAge: maxAge ?? COOKIE_MAX_AGE_S,
  };
}

/** Cookie options for short-lived OIDC flow params (state, code_verifier). 5 min TTL. */
export function oidcFlowCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const, // Lax required — callback is a cross-site redirect from Keycloak
    path: "/",
    maxAge: 300, // 5 minutes — enough for the OIDC round-trip
  };
}

/** OIDC flow cookie names. */
export const OIDC_STATE_COOKIE = "oidc_state";
export const OIDC_VERIFIER_COOKIE = "oidc_code_verifier";
export const OIDC_NONCE_COOKIE = "oidc_nonce";

/** Generate a cryptographically random URL-safe string. */
export function generateRandom(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Generate PKCE code_challenge from code_verifier (S256). */
export function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
