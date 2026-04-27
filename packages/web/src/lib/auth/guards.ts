import "server-only";

import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { JWT_COOKIE_NAME } from "./keycloak";
import { verifyKeycloakJwt } from "./verify-keycloak-jwt";

/**
 * Single source of truth for which application roles satisfy each permission
 * tier. Mirrors the API-side `requireAuth` / `requireWrite` / `requireOrgAdmin`
 * guards in `packages/api/src/lib/guards.ts` — keep both maps in sync. Any
 * future role change (e.g. adding `finance_viewer`) lands here once.
 */
export type Permission = "admin" | "write" | "read";
const PERMISSION_ROLES: Record<Permission, readonly string[]> = {
  admin: ["org_admin"],
  write: ["org_admin", "user"],
  read: ["org_admin", "user", "viewer"],
};

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
    roles: [...(payload.realm_access?.roles ?? []), ...(payload.role ? [payload.role] : [])],
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

async function verifyJwt(token: string) {
  try {
    return await verifyKeycloakJwt(token);
  } catch {
    return null;
  }
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
 * Non-redirecting permission check for conditional rendering inside a
 * Server Component (e.g. hiding a "+ New" CTA from a `viewer`). For route
 * protection, use `requirePermission` which redirects/404s instead.
 *
 * Sourced from the same `PERMISSION_ROLES` table as `requirePermission`
 * so the affordance gating and the route gate cannot drift apart.
 */
export function hasPermission(auth: ServerAuthContext, permission: Permission): boolean {
  const allowed = PERMISSION_ROLES[permission];
  return auth.roles.some((r) => allowed.includes(r));
}

/**
 * Require a specific application permission in a Server Component.
 *
 * - Unauthenticated → redirect to `/login` (handled by `requireAuth`).
 * - Authenticated but lacks the permission → `notFound()`. We do NOT redirect
 *   to `/login` because the user IS logged in — bouncing them to the login
 *   form would either loop (their cookie is valid) or mislead them into
 *   thinking the session expired. 404 mirrors the API-side `requireSuperAdmin`
 *   anti-disclosure pattern in `packages/api/src/lib/guards.ts:74-91`.
 *
 * Permission hierarchy: org_admin > user > viewer.
 */
export async function requirePermission(permission: Permission): Promise<ServerAuthContext> {
  const auth = await requireAuth();

  if (!hasPermission(auth, permission)) {
    notFound();
  }

  return auth;
}

/** Require org_admin access in a Server Component. */
export async function requireOrgAdmin(): Promise<ServerAuthContext> {
  return requirePermission("admin");
}
