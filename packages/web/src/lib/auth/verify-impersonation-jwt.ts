import "server-only";

import { type JWTPayload, jwtVerify } from "jose";

/**
 * Verifier for the app-layer impersonation token (issue #24).
 *
 * Mirrors `packages/api/src/lib/impersonation/jwt.ts` so the web SSR can
 * decode the same cookie the API sets. Issuer is the literal
 * "givernance-impersonation"; signature is HS256 against
 * IMPERSONATION_JWT_SECRET shared with the API. When
 * IMPERSONATION_USE_KEYCLOAK_EXCHANGE=true, the realm signs the token
 * instead — the auth verifier in `verify-keycloak-jwt.ts` handles that
 * path; this file is only the app-layer (HS256) branch.
 */
export const IMPERSONATION_TOKEN_ISSUER = "givernance-impersonation";

export type ImpersonationModeName = "delegation" | "impersonation";

export interface ImpersonationJwtPayload {
  sub: string;
  org_id: string;
  email: string;
  role?: string;
  realm_access?: { roles?: string[] };
  act: { sub: string };
  imp_mode: ImpersonationModeName;
  imp_session_id: string;
  imp_reason: string;
  exp: number;
  iat?: number;
  jti?: string;
}

let cachedSecret: Uint8Array | null = null;
function getSecret(): Uint8Array {
  if (cachedSecret) return cachedSecret;
  const raw = process.env.IMPERSONATION_JWT_SECRET;
  if (!raw) {
    cachedSecret = new TextEncoder().encode(
      "givernance-dev-impersonation-jwt-secret-stub-do-not-use",
    );
    return cachedSecret;
  }
  cachedSecret = new TextEncoder().encode(raw);
  return cachedSecret;
}

export async function verifyImpersonationJwt(token: string): Promise<ImpersonationJwtPayload> {
  const { payload } = await jwtVerify(token, getSecret(), {
    issuer: IMPERSONATION_TOKEN_ISSUER,
    algorithms: ["HS256"],
  });

  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("Impersonation token missing required `sub` claim");
  }

  const mode = (payload as Record<string, unknown>).imp_mode;
  if (mode !== "delegation" && mode !== "impersonation") {
    throw new Error(`Impersonation token has unknown imp_mode: ${String(mode)}`);
  }

  return payload as unknown as ImpersonationJwtPayload;
}

/**
 * Cheap pre-check — peeks at the unverified `iss` claim to route a token
 * through the correct verifier. The signature is checked by whichever
 * verifier the caller dispatches to.
 */
export function looksLikeImpersonationToken(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1] ?? "", "base64url").toString("utf8"),
    ) as JWTPayload;
    return payload.iss === IMPERSONATION_TOKEN_ISSUER;
  } catch {
    return false;
  }
}
