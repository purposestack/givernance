import { createRemoteJWKSet, jwtVerify } from "jose";
import { env } from "../env.js";

export interface KeycloakJwtClaims {
  sub: string;
  org_id: string;
  email: string;
  realm_access?: { roles?: string[] };
  role?: string;
  act?: { sub: string };
  /** JWT id — used by the session blocklist for `switch-org` revocations. */
  jti?: string;
  /** Expiry (seconds-epoch). */
  exp?: number;
  /** Seconds-epoch when the user authenticated; needed for step-up checks (issue #24). */
  auth_time?: number;
  /** Authentication Context Class Reference — `"2"` ⇒ MFA-backed login. */
  acr?: string;
  /**
   * Keycloak SSO session id. Stable across access-token refreshes for the
   * same Keycloak session — what OIDC back-channel logout (issue #76 / PR-2)
   * blocklists when an admin or sibling-device sign-out invalidates the
   * upstream session before the access token would naturally expire.
   */
  sid?: string;
}

const KEYCLOAK_ISSUER = env.KEYCLOAK_ISSUER ?? `${env.KEYCLOAK_URL}/realms/${env.KEYCLOAK_REALM}`;
const KEYCLOAK_INTERNAL_BASE = env.KEYCLOAK_INTERNAL_URL ?? env.KEYCLOAK_URL;
const KEYCLOAK_JWKS_URL =
  env.KEYCLOAK_JWKS_URL ??
  `${KEYCLOAK_INTERNAL_BASE}/realms/${env.KEYCLOAK_REALM}/protocol/openid-connect/certs`;

/**
 * Shared JWKS for the realm. Reused by `verifyKeycloakJwt` (access tokens)
 * and `verifyBackchannelLogoutToken` (issue #76 / PR-2) so they go through
 * the same key-rotation cache instead of opening two parallel remote sets.
 */
export const keycloakJwks = createRemoteJWKSet(new URL(KEYCLOAK_JWKS_URL));

/** Realm issuer string — exported so logout-token verification can reuse it. */
export const keycloakIssuer = KEYCLOAK_ISSUER;

export async function verifyKeycloakJwt(token: string): Promise<KeycloakJwtClaims> {
  const { payload } = await jwtVerify(token, keycloakJwks, {
    issuer: KEYCLOAK_ISSUER,
    algorithms: ["RS256"],
  });

  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("Keycloak token missing required `sub` claim");
  }

  if (typeof payload.org_id !== "string" || payload.org_id.length === 0) {
    throw new Error("Keycloak token missing required `org_id` claim");
  }

  if (typeof payload.email !== "string" || payload.email.length === 0) {
    throw new Error("Keycloak token missing required `email` claim");
  }

  return payload as unknown as KeycloakJwtClaims;
}
