/** Shared route guards — reusable preHandler hooks for auth and RBAC */

import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Structured discriminator written by every RBAC guard before sending its
 * 403/404 (issue #182). Lifts the response onto a request-scoped property so
 * the audit plugin's `onResponse` log line can include the guard name +
 * required/actual role. SOC dashboards filter on `rbacDenial.guard` to
 * separate RBAC denials from CSRF / validation / tenant-scoping denials,
 * which all currently land as 403 with no other discriminator.
 */
export interface RbacDenial {
  /** Guard primitive that emitted the denial. */
  guard:
    | "requireAuth"
    | "requireWrite"
    | "requireOrgAdmin"
    | "requireSuperAdmin"
    | "requireSuperAdminOrOwnOrgAdmin";
  /** Logical role the guard required. `null` for the unauthenticated branch. */
  requiredRole: string | null;
  /** Actual application role on the JWT, if present. */
  actualRole: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Populated by RBAC guards on the denial path. Picked up by the audit
     * plugin's `onResponse` log line for SOC observability (issue #182).
     */
    rbacDenial?: RbacDenial;
  }
}

/**
 * Emit a structured `rbac denial` warning AND attach the discriminator to
 * the request so the audit plugin's `onResponse` line carries it. Centralising
 * here keeps the five guards below identical in shape.
 */
function recordRbacDenial(request: FastifyRequest, denial: RbacDenial) {
  request.rbacDenial = denial;
  request.log.warn({ rbacDenial: denial }, "rbac denial");
}

/** Guard: require valid JWT (any authenticated user) */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  if (!request.auth?.userId) {
    recordRbacDenial(request, {
      guard: "requireAuth",
      requiredRole: null,
      actualRole: null,
    });
    return reply.status(401).send({
      type: "https://httpproblems.com/http-status/401",
      title: "Unauthorized",
      status: 401,
      detail: "Authentication required",
    });
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
    recordRbacDenial(request, {
      guard: "requireWrite",
      requiredRole: "user|org_admin",
      actualRole: null,
    });
    return reply.status(401).send({
      type: "https://httpproblems.com/http-status/401",
      title: "Unauthorized",
      status: 401,
      detail: "Authentication required",
    });
  }
  if (request.auth.role !== "org_admin" && request.auth.role !== "user") {
    recordRbacDenial(request, {
      guard: "requireWrite",
      requiredRole: "user|org_admin",
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
    recordRbacDenial(request, {
      guard: "requireOrgAdmin",
      requiredRole: "org_admin",
      actualRole: null,
    });
    return reply.status(401).send({
      type: "https://httpproblems.com/http-status/401",
      title: "Unauthorized",
      status: 401,
      detail: "Authentication required",
    });
  }
  if (request.auth.role !== "org_admin") {
    recordRbacDenial(request, {
      guard: "requireOrgAdmin",
      requiredRole: "org_admin",
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
    recordRbacDenial(request, {
      guard: "requireSuperAdmin",
      requiredRole: "super_admin",
      actualRole: null,
    });
    return reply.status(401).send({
      type: "https://httpproblems.com/http-status/401",
      title: "Unauthorized",
      status: 401,
      detail: "Authentication required",
    });
  }
  if (!request.auth.roles.includes("super_admin")) {
    recordRbacDenial(request, {
      guard: "requireSuperAdmin",
      requiredRole: "super_admin",
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
    recordRbacDenial(request, {
      guard: "requireSuperAdminOrOwnOrgAdmin",
      requiredRole: "super_admin|org_admin(own)",
      actualRole: null,
    });
    return reply.status(401).send({
      type: "https://httpproblems.com/http-status/401",
      title: "Unauthorized",
      status: 401,
      detail: "Authentication required",
    });
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
    requiredRole: "super_admin|org_admin(own)",
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
