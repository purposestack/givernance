/** Shared route guards — reusable preHandler hooks for auth and RBAC */

import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

/** Guard: require valid JWT (any authenticated user) */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  if (!request.auth?.userId) {
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
    return reply.status(401).send({
      type: "https://httpproblems.com/http-status/401",
      title: "Unauthorized",
      status: 401,
      detail: "Authentication required",
    });
  }
  if (request.auth.role !== "org_admin" && request.auth.role !== "user") {
    return reply.status(403).send({
      type: "https://httpproblems.com/http-status/403",
      title: "Forbidden",
      status: 403,
      detail: "write access required",
    });
  }
}

/** Guard: require org_admin role */
export async function requireOrgAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (!request.auth?.userId) {
    return reply.status(401).send({
      type: "https://httpproblems.com/http-status/401",
      title: "Unauthorized",
      status: 401,
      detail: "Authentication required",
    });
  }
  if (request.auth.role !== "org_admin") {
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
    return reply.status(401).send({
      type: "https://httpproblems.com/http-status/401",
      title: "Unauthorized",
      status: 401,
      detail: "Authentication required",
    });
  }
  if (!request.auth.roles.includes("super_admin")) {
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
