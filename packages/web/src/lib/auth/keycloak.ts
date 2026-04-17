import "server-only";

/**
 * Keycloak OIDC configuration — centralised for all auth API routes.
 * Environment variables follow ADR-011 naming: server-only vars have no NEXT_PUBLIC_ prefix.
 */

export const KEYCLOAK_URL = process.env.KEYCLOAK_URL ?? "http://localhost:8080";
export const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM ?? "givernance";
export const KEYCLOAK_CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID ?? "givernance-web";
export const KEYCLOAK_CLIENT_SECRET = process.env.KEYCLOAK_CLIENT_SECRET ?? "";
export const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

/** Keycloak OpenID Connect endpoints. */
export const AUTH_ENDPOINT = `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/auth`;
export const TOKEN_ENDPOINT = `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`;
export const LOGOUT_ENDPOINT = `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/logout`;

/** JWT cookie name — consistent across middleware, layout, and API routes. */
export const JWT_COOKIE_NAME = "givernance_jwt";

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
