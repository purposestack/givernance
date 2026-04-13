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
