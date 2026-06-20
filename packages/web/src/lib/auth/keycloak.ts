import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { KEYCLOAK_DEFAULT_CLIENT_ID } from "@givernance/shared/constants";
import {
  authScopedCookieOptions,
  COOKIE_MAX_AGE_S,
  ID_TOKEN_COOKIE_NAME,
  JWT_COOKIE_NAME,
  jwtCookieOptions,
  REFRESH_TOKEN_COOKIE_NAME,
  resolveSessionMaxAge,
} from "./session";

/**
 * Keycloak OIDC configuration — centralised for all auth API routes.
 * Environment variables follow ADR-011 naming: server-only vars have no NEXT_PUBLIC_ prefix.
 */

export const KEYCLOAK_URL = process.env.KEYCLOAK_URL ?? "http://localhost:8080";
export const KEYCLOAK_INTERNAL_URL = process.env.KEYCLOAK_INTERNAL_URL ?? KEYCLOAK_URL;
export const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM ?? "givernance";
export const KEYCLOAK_CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID ?? KEYCLOAK_DEFAULT_CLIENT_ID;
export const KEYCLOAK_ISSUER =
  process.env.KEYCLOAK_ISSUER ?? `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}`;
export const KEYCLOAK_JWKS_URL =
  process.env.KEYCLOAK_JWKS_URL ??
  `${KEYCLOAK_INTERNAL_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/certs`;
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
export const TOKEN_ENDPOINT = `${KEYCLOAK_INTERNAL_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`;
export const LOGOUT_ENDPOINT = `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/logout`;

export {
  authScopedCookieOptions,
  COOKIE_MAX_AGE_S,
  ID_TOKEN_COOKIE_NAME,
  JWT_COOKIE_NAME,
  jwtCookieOptions,
  REFRESH_TOKEN_COOKIE_NAME,
  resolveSessionMaxAge,
};

/**
 * Issue #296 cookie-path migration. Before #296, `id_token` +
 * `refresh_token` were set at `Path=/`; after the cutover they live at
 * `Path=/api/auth`. A browser holding a pre-cutover session carries BOTH
 * copies until the root-path ones expire — and the stale root-path
 * refresh cookie can shadow the scoped one on `/api/auth/refresh`,
 * producing a spurious `invalid_grant` logout. Expiring the legacy
 * `Path=/` pair whenever we write or clear the session makes the
 * migration seamless within a single response. Typed structurally so this
 * server-only module doesn't pull in `next/headers`.
 */
export function deleteLegacyRootSessionCookies(jar: {
  delete: (opts: { name: string; path: string }) => void;
}): void {
  jar.delete({ name: ID_TOKEN_COOKIE_NAME, path: "/" });
  jar.delete({ name: REFRESH_TOKEN_COOKIE_NAME, path: "/" });
}

/**
 * Same-origin path validator for the OIDC `return_to` parameter / cookie
 * (issue #250). Resolves the candidate against `APP_URL` using the
 * WHATWG URL parser (which normalises `\`/`%5c`/percent-encoded slashes
 * etc.), then compares the resolved origin to APP_URL's. Returns the
 * resolved same-origin path (or `null` if cross-origin / malformed /
 * scheme-bearing).
 *
 * Shared by `/api/auth/login` (request-time validation) and
 * `/api/auth/callback` (cookie-time re-validation as defence-in-depth
 * against tampering). Multi-agent review I-2 (PR #251) caught the two
 * routes had divergent validators — a hand-rolled prefix check on the
 * callback side was missing some of the bypasses the login route's
 * URL-based check rejected. Sharing the helper makes drift impossible.
 */
export function safeReturnToPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/")) return null;
  // Reject control chars / CRLF / null bytes — defence-in-depth against
  // header smuggling if the value were ever echoed in a Set-Cookie or
  // Location header without re-encoding.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: explicit defence-in-depth filter (CRLF / null-byte smuggling)
  if (/[\x00-\x1f\x7f]/.test(raw)) return null;
  let resolved: URL;
  let appOrigin: URL;
  try {
    resolved = new URL(raw, APP_URL);
    appOrigin = new URL(APP_URL);
  } catch {
    return null;
  }
  if (resolved.origin !== appOrigin.origin) return null;
  // Return the resolved same-origin path so the caller never echoes an
  // absolute URL by accident.
  return resolved.pathname + resolved.search + resolved.hash;
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

/**
 * Cookie options for the post-callback `return_to` cookie (issue #250).
 * Same TTL/security flags as the other OIDC flow cookies, but scoped to
 * `/api/auth` so it only round-trips between the login + callback routes
 * — defence-in-depth on top of the httpOnly flag.
 */
export function returnToCookieOptions() {
  return {
    ...oidcFlowCookieOptions(),
    path: "/api/auth",
  };
}

/** OIDC flow cookie names. */
export const OIDC_STATE_COOKIE = "oidc_state";
export const OIDC_VERIFIER_COOKIE = "oidc_code_verifier";
export const OIDC_NONCE_COOKIE = "oidc_nonce";
/** Same-origin path the callback redirects to after a successful re-auth (issue #250 step-up). */
export const OIDC_RETURN_TO_COOKIE = "oidc_return_to";

/** Generate a cryptographically random URL-safe string. */
export function generateRandom(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Generate PKCE code_challenge from code_verifier (S256). */
export function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
