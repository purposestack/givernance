/** Shared route guards — reusable preHandler hooks for auth and RBAC */

import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Two distinct discriminators (issue #182, refined in PR #185 review
 * PJD-5 / L1 / L2 / S5):
 *
 *   - `authDenial`: the JWT was missing or unusable (the 401 path). SOC
 *     filtering for *RBAC probing* should EXCLUDE these to keep signal
 *     clean; SOC filtering for *cookie-expiry / token-rotation noise*
 *     wants only these.
 *   - `rbacDenial`: a valid JWT presented an insufficient role (the 403
 *     /404 path). `requiredRoles` is a structured array (machine-parseable
 *     in LogQL) plus an optional `tenantScoped` flag for the "(own org)"
 *     constraint that `requireSuperAdminOrOwnOrgAdmin` adds on top of the
 *     role list.
 *
 * Both shapes carry `guard` so a SOC dashboard can group by primitive.
 */
export type GuardName =
  | "requireAuth"
  | "requireWrite"
  | "requireOrgAdmin"
  | "requireSuperAdmin"
  | "requireSuperAdminOrOwnOrgAdmin";

export interface AuthDenial {
  guard: GuardName;
  /** Reason the unauth branch fired. Currently always missing/invalid token. */
  reason: "missing_token";
}

export interface RbacDenial {
  guard: GuardName;
  /** Roles that would have satisfied the guard. Machine-parseable. */
  requiredRoles: string[];
  /** True when the guard also required tenant-ownership on top of the role. */
  tenantScoped?: boolean;
  /** Application role on the JWT. `null` when the JWT had no role claim. */
  actualRole: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set when the 401 unauth branch fires (review PJD-5 / L2). */
    authDenial?: AuthDenial;
    /** Set when a valid JWT presented the wrong role (issue #182). */
    rbacDenial?: RbacDenial;
  }
}

function recordAuthDenial(request: FastifyRequest, denial: AuthDenial): void {
  request.authDenial = denial;
  request.log.warn({ authDenial: denial }, "auth denial");
}

function recordRbacDenial(request: FastifyRequest, denial: RbacDenial): void {
  request.rbacDenial = denial;
  request.log.warn({ rbacDenial: denial }, "rbac denial");
}

function unauthorized(reply: FastifyReply) {
  return reply.status(401).send({
    type: "https://httpproblems.com/http-status/401",
    title: "Unauthorized",
    status: 401,
    detail: "Authentication required",
  });
}

/** Guard: require valid JWT (any authenticated user) */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  if (!request.auth?.userId) {
    recordAuthDenial(request, { guard: "requireAuth", reason: "missing_token" });
    return unauthorized(reply);
  }
}

/**
 * Guard: require write access — accepts `org_admin` and `user`, blocks
 * `viewer`. Use on operational write endpoints (create / update of
 * fundraising data) where viewers should stay read-only but staff in the
 * `user` role need parity with admins. For destructive admin actions
 * (delete, status transitions, settings) use `requireOrgAdmin` instead.
 */
export async function requireWrite(request: FastifyRequest, reply: FastifyReply) {
  if (!request.auth?.userId) {
    recordAuthDenial(request, { guard: "requireWrite", reason: "missing_token" });
    return unauthorized(reply);
  }
  if (request.auth.role !== "org_admin" && request.auth.role !== "user") {
    recordRbacDenial(request, {
      guard: "requireWrite",
      requiredRoles: ["user", "org_admin"],
      actualRole: request.auth.role ?? null,
    });
    return reply.status(403).send({
      type: "https://httpproblems.com/http-status/403",
      title: "Forbidden",
      status: 403,
      detail: "Write access required",
    });
  }
}

/** Guard: require org_admin role */
export async function requireOrgAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (!request.auth?.userId) {
    recordAuthDenial(request, { guard: "requireOrgAdmin", reason: "missing_token" });
    return unauthorized(reply);
  }
  if (request.auth.role !== "org_admin") {
    recordRbacDenial(request, {
      guard: "requireOrgAdmin",
      requiredRoles: ["org_admin"],
      actualRole: request.auth.role ?? null,
    });
    return reply.status(403).send({
      type: "https://httpproblems.com/http-status/403",
      title: "Forbidden",
      status: 403,
      detail: "org_admin role required",
    });
  }
}

/**
 * Guard: require super_admin realm role (Keycloak).
 *
 * SEC-5 (PR #118 review): for admin-namespaced JSON routes we want the same
 * "404 don't disclose existence" behaviour the `(admin)` web layout already
 * enforces via `notFound()`. Authenticated non-super-admins see 404 instead
 * of 403 so the attack surface is not discoverable through role probing.
 * Unauthenticated callers still get 401 — they could be legitimate users
 * whose cookie expired.
 */
export async function requireSuperAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (!request.auth?.userId) {
    recordAuthDenial(request, { guard: "requireSuperAdmin", reason: "missing_token" });
    return unauthorized(reply);
  }
  if (!request.auth.roles.includes("super_admin")) {
    recordRbacDenial(request, {
      guard: "requireSuperAdmin",
      requiredRoles: ["super_admin"],
      actualRole: request.auth.role ?? null,
    });
    return reply.status(404).send({
      type: "https://httpproblems.com/http-status/404",
      title: "Not Found",
      status: 404,
      detail: "Not Found",
    });
  }
}

/** Guard: require super_admin, or org_admin accessing their own tenant-scoped admin route */
export async function requireSuperAdminOrOwnOrgAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (!request.auth?.userId) {
    recordAuthDenial(request, {
      guard: "requireSuperAdminOrOwnOrgAdmin",
      reason: "missing_token",
    });
    return unauthorized(reply);
  }

  if (request.auth.roles.includes("super_admin")) {
    return;
  }

  const params = request.params as { orgId?: string };
  if (
    request.auth.role === "org_admin" &&
    request.auth.orgId &&
    request.auth.orgId === params.orgId
  ) {
    return;
  }

  recordRbacDenial(request, {
    guard: "requireSuperAdminOrOwnOrgAdmin",
    requiredRoles: ["super_admin", "org_admin"],
    tenantScoped: true,
    actualRole: request.auth.role ?? null,
  });
  return reply.status(403).send({
    type: "https://httpproblems.com/http-status/403",
    title: "Forbidden",
    status: 403,
    detail: "super_admin or owning org_admin role required",
  });
}

/** Guard: require x-admin-secret header matching ADMIN_SECRET env var (timing-safe) */
export async function requireAdminSecret(request: FastifyRequest, reply: FastifyReply) {
  const secret = request.headers["x-admin-secret"] as string | undefined;
  const adminSecret = process.env["ADMIN_SECRET"];

  if (!secret || !adminSecret || !safeCompare(secret, adminSecret)) {
    return reply.status(401).send({
      type: "https://httpproblems.com/http-status/401",
      title: "Unauthorized",
      status: 401,
      detail: "Invalid admin secret",
    });
  }
}

/** Constant-time string comparison to prevent timing attacks (M1 fix) */
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
