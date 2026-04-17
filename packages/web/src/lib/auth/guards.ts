import "server-only";

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
  /** RFC 8693 actor claim — present during impersonation. */
  act?: { sub: string };
  exp?: number;
}

/**
 * Decode a JWT payload without verification.
 *
 * In Phase 1, signature verification is handled by the API server — the
 * frontend trusts the httpOnly cookie set by the callback route. Full JWT
 * verification (JWKS fetching) will be added when the auth middleware moves
 * to Edge-compatible jose library in Phase 2.
 */
function decodeJwtPayload(token: string): JwtPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const base64 = parts[1];
    if (!base64) return null;
    const payload = JSON.parse(atob(base64)) as JwtPayload;
    // Check expiration
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
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
}

/**
 * Require authentication in a Server Component or Route Handler.
 * Redirects to /login if no valid JWT cookie is found.
 */
export async function requireAuth(): Promise<ServerAuthContext> {
  const cookieStore = await cookies();
  const token = cookieStore.get(JWT_COOKIE_NAME)?.value;

  if (!token) {
    redirect("/login");
  }

  const payload = decodeJwtPayload(token);
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
