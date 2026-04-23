import "server-only";

import { createRemoteJWKSet, jwtVerify } from "jose";
import { KEYCLOAK_ISSUER, KEYCLOAK_JWKS_URL } from "./keycloak";

export interface KeycloakJwtPayload {
  sub: string;
  email?: string;
  given_name?: string;
  family_name?: string;
  role?: string;
  realm_access?: { roles?: string[] };
  resource_access?: Record<string, { roles: string[] }>;
  org_id: string;
  act?: { sub: string };
  imp_session_id?: string;
  imp_reason?: string;
  exp?: number;
}

const keycloakJwks = createRemoteJWKSet(new URL(KEYCLOAK_JWKS_URL));

export async function verifyKeycloakJwt(token: string): Promise<KeycloakJwtPayload> {
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

  return payload as unknown as KeycloakJwtPayload;
}
