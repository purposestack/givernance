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
}

const KEYCLOAK_ISSUER = env.KEYCLOAK_ISSUER ?? `${env.KEYCLOAK_URL}/realms/${env.KEYCLOAK_REALM}`;
const KEYCLOAK_JWKS_URL =
  env.KEYCLOAK_JWKS_URL ?? `${KEYCLOAK_ISSUER}/protocol/openid-connect/certs`;

const keycloakJwks = createRemoteJWKSet(new URL(KEYCLOAK_JWKS_URL));

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
