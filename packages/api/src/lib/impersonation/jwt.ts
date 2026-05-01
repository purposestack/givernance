/**
 * App-layer impersonation JWT signing/verification.
 *
 * Issuer is `givernance-impersonation` — a distinct value from the realm's
 * issuer string — so the auth plugin can route tokens by `iss` without
 * accidentally feeding an impersonation token through the realm's JWKS
 * (and vice-versa). When `IMPERSONATION_USE_KEYCLOAK_EXCHANGE=true` the
 * JWT is minted by Keycloak instead and `iss` mirrors the realm; both
 * paths surface identical claims to callers, so the auth plugin handles
 * them through one branch.
 */

import { randomUUID } from "node:crypto";
import { type JWTPayload, jwtVerify, SignJWT } from "jose";
import { env } from "../../env.js";
import type { ImpersonationModeName, ImpersonationTokenClaims } from "./types.js";

export const IMPERSONATION_TOKEN_ISSUER = "givernance-impersonation";

interface MintArgs {
  sessionId: string;
  mode: ImpersonationModeName;
  reason: string;
  targetKeycloakId: string;
  targetOrgId: string;
  targetRole: string;
  targetEmail: string;
  /** Roles array carried in `realm_access.roles`. Mode-specific — see types.ts. */
  roles: string[];
  impersonatorKeycloakId: string;
  ttlSeconds: number;
}

export async function signImpersonationToken(
  args: MintArgs,
): Promise<{ token: string; jti: string; exp: number }> {
  const secret = getSecret();
  const jti = randomUUID();
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + args.ttlSeconds;

  const token = await new SignJWT({
    sub: args.targetKeycloakId,
    org_id: args.targetOrgId,
    role: args.targetRole,
    email: args.targetEmail,
    act: { sub: args.impersonatorKeycloakId },
    imp_mode: args.mode,
    imp_session_id: args.sessionId,
    imp_reason: args.reason,
    realm_access: { roles: args.roles },
  } satisfies Omit<ImpersonationTokenClaims, "iat" | "exp" | "iss" | "jti">)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(IMPERSONATION_TOKEN_ISSUER)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setJti(jti)
    .sign(secret);

  return { token, jti, exp };
}

export async function verifyImpersonationToken(token: string): Promise<ImpersonationTokenClaims> {
  const secret = getSecret();
  const { payload } = await jwtVerify(token, secret, {
    issuer: IMPERSONATION_TOKEN_ISSUER,
    algorithms: ["HS256"],
  });

  assertImpersonationShape(payload);
  return payload as unknown as ImpersonationTokenClaims;
}

/**
 * Discriminator for the auth plugin — checks the `iss` claim against the
 * impersonation issuer without verifying the signature. Cheap to call
 * before deciding which JWKS / secret to verify against.
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

function assertImpersonationShape(payload: JWTPayload): void {
  const required: Array<keyof ImpersonationTokenClaims> = [
    "sub",
    "org_id",
    "role",
    "email",
    "act",
    "imp_mode",
    "imp_session_id",
    "imp_reason",
    "realm_access",
  ];
  for (const key of required) {
    if ((payload as Record<string, unknown>)[key] === undefined) {
      throw new Error(`Impersonation token missing required claim: ${String(key)}`);
    }
  }
  const act = (payload as Record<string, unknown>).act as { sub?: unknown } | undefined;
  if (typeof act?.sub !== "string" || act.sub.length === 0) {
    throw new Error("Impersonation token `act.sub` claim is missing or empty");
  }
  const mode = (payload as Record<string, unknown>).imp_mode;
  if (mode !== "delegation" && mode !== "impersonation") {
    throw new Error(`Impersonation token has unknown imp_mode: ${String(mode)}`);
  }
}

let cachedSecret: Uint8Array | null = null;
function getSecret(): Uint8Array {
  if (cachedSecret) return cachedSecret;
  const raw = env.IMPERSONATION_JWT_SECRET;
  // Local dev / CI without an explicit secret: derive a deterministic
  // 32-byte stub from a fixed marker. Not used in production — env.ts
  // hard-fails when IMPERSONATION_JWT_SECRET is missing under
  // NODE_ENV=production.
  if (!raw) {
    cachedSecret = new TextEncoder().encode(
      "givernance-dev-impersonation-jwt-secret-stub-do-not-use",
    );
    return cachedSecret;
  }
  cachedSecret = new TextEncoder().encode(raw);
  return cachedSecret;
}
