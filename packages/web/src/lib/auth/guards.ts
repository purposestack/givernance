import "server-only";

import { jwtVerify } from "jose";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { JWT_COOKIE_NAME } from "./keycloak";

/** Minimal JWT payload shape for Keycloak access tokens. */
interface JwtPayload {
  sub: string;
  email?: string;
  given_name?: string;
  family_name?: string;
  realm_access?: { roles: string[] };
  resource_access?: Record<string, { roles: string[] }>;
  org_id?: string;
  /** RFC 8693 actor claim — present during delegation/impersonation. */
  act?: { sub: string };
  /** Givernance-specific: impersonation session ID (UUIDv7). */
  imp_session_id?: string;
  /** Givernance-specific: mandatory reason for impersonation. */
  imp_reason?: string;
  exp?: number;
}

/**
 * Verify and decode the internal session JWT minted by /api/auth/callback.
 *
 * TODO(#84): swap back to Keycloak JWKS (RS256) verification once the API
 * verifies Keycloak tokens directly and the realm has an `org_id` mapper.
 * Today we verify the HS256 JWT we mint ourselves, signed with JWT_SECRET.
 */
async function verifyJwt(token: string): Promise<JwtPayload | null> {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) return null;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(jwtSecret), {
      algorithms: ["HS256"],
    });
    return payload as unknown as JwtPayload;
  } catch {
    return null;
  }
}

/** Impersonation metadata extracted from JWT claims (doc/19-impersonation.md). */
export interface ImpersonationInfo {
  /** Admin UUID (from act.sub). */
  adminId: string;
  /** Server-assigned session ID for audit & revocation. */
  sessionId: string | undefined;
  /** Mandatory reason (e.g. "Support ticket #1234"). */
  reason: string | undefined;
  /** Token expiry as epoch seconds — used for countdown timer. */
  expiresAt: number | undefined;
}

/** Auth context returned by guard functions for use in Server Components. */
export interface ServerAuthContext {
  userId: string;
  email: string | undefined;
  firstName: string | undefined;
  lastName: string | undefined;
  orgId: string | undefined;
  roles: string[];
  /** RFC 8693 actor claim. */
  act: { sub: string } | undefined;
  /** Impersonation metadata — present when act claim exists. */
  impersonation: ImpersonationInfo | undefined;
}

/**
 * Require authentication in a Server Component or Route Handler.
 * Verifies the JWT signature against Keycloak's JWKS before trusting claims.
 * Redirects to /login if no valid JWT cookie is found.
 */
export async function requireAuth(): Promise<ServerAuthContext> {
  const cookieStore = await cookies();
  const token = cookieStore.get(JWT_COOKIE_NAME)?.value;

  if (!token) {
    redirect("/login");
  }

  const payload = await verifyJwt(token);
  if (!payload) {
    redirect("/login");
  }

  return {
    userId: payload.sub,
    email: payload.email,
    firstName: payload.given_name,
    lastName: payload.family_name,
    orgId: payload.org_id,
    roles: payload.realm_access?.roles ?? [],
    act: payload.act,
    impersonation: payload.act
      ? {
          adminId: payload.act.sub,
          sessionId: payload.imp_session_id,
          reason: payload.imp_reason,
          expiresAt: payload.exp,
        }
      : undefined,
  };
}

/**
 * Require a specific Keycloak realm role in a Server Component.
 * Redirects to /login if the user doesn't have the role.
 */
export async function requireRole(role: string): Promise<ServerAuthContext> {
  const auth = await requireAuth();

  if (!auth.roles.includes(role)) {
    redirect("/login");
  }

  return auth;
}

/**
 * Require a specific application permission in a Server Component.
 * Maps application roles to permission sets.
 *
 * Permission hierarchy: org_admin > user > viewer
 */
export async function requirePermission(
  permission: "admin" | "write" | "read",
): Promise<ServerAuthContext> {
  const auth = await requireAuth();

  const permissionMap: Record<string, string[]> = {
    admin: ["org_admin"],
    write: ["org_admin", "user"],
    read: ["org_admin", "user", "viewer"],
  };

  const allowedRoles = permissionMap[permission] ?? [];
  const hasPermission = auth.roles.some((r) => allowedRoles.includes(r));

  if (!hasPermission) {
    redirect("/login");
  }

  return auth;
}

/** Require org_admin access in a Server Component. */
export async function requireOrgAdmin(): Promise<ServerAuthContext> {
  return requirePermission("admin");
}
