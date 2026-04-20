import "server-only";

import { decodeJwt, SignJWT } from "jose";

/**
 * Dev-only: mint an internal HS256 session JWT after a successful Keycloak
 * login, so the Fastify API (which verifies with JWT_SECRET) accepts it.
 *
 * TODO(#84): replace with proper RS256 JWKS verification on the API side and
 * an `org_id` protocol mapper on the Keycloak realm, then store the Keycloak
 * access token directly. This shim exists to unblock local dev until the
 * Phase 1 Multi-Tenant SSO onboarding lands.
 */

const DEFAULT_DEV_ORG_ID = "00000000-0000-0000-0000-0000000000a1";

export interface SessionClaims {
  sub: string;
  org_id: string;
  email: string;
  role: "org_admin" | "user" | "read_only";
  realm_access: { roles: string[] };
}

export async function mintSessionJwt(
  keycloakAccessToken: string,
  expiresInSeconds: number,
): Promise<string> {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error("JWT_SECRET environment variable is required to mint session JWTs");
  }

  const kc = decodeJwt(keycloakAccessToken) as {
    sub?: string;
    email?: string;
    preferred_username?: string;
    realm_access?: { roles?: string[] };
  };

  if (!kc.sub) {
    throw new Error("Keycloak access token missing 'sub' claim");
  }

  const orgId = process.env.DEV_DEFAULT_ORG_ID ?? DEFAULT_DEV_ORG_ID;
  const realmRoles = kc.realm_access?.roles ?? [];

  const claims: SessionClaims = {
    sub: kc.sub,
    org_id: orgId,
    email: kc.email ?? kc.preferred_username ?? "unknown@givernance.local",
    role: "org_admin",
    realm_access: { roles: realmRoles },
  };

  return new SignJWT(claims as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSeconds)
    .sign(new TextEncoder().encode(jwtSecret));
}
