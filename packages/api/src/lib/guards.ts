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
  | "requireSuperAdminOrOwnOrgAdmin"
  | "requireBankMutationAcr";

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

/**
 * Guard: require bank-mutation step-up (ADR-032 §2.7).
 *
 * Bank account mutation endpoints (POST / PATCH / DELETE) require an MFA-backed
 * re-authentication: `acr >= 2` AND an `auth_time` no older than 900 seconds
 * (15 minutes). Both must hold — a fresh re-auth at LoA 1 is insufficient, and
 * LoA 2 on a stale session is equally insufficient.
 *
 * The LoA-2 contract is the one the realm actually issues (`acr.loa.map` maps
 * only {"1","2"}) and the one the web step-up requests (`acr_values=2`). An
 * earlier revision of this guard demanded a bespoke
 * `urn:givernance:acr:bank-mutation` value that NO flow, client scope or web
 * code ever produces — which made every bank mutation a permanent 401 the
 * moment it shipped. Reusing the proven LoA contract keeps the control real
 * instead of creating pressure to disable it in production (B4).
 *
 * On failure the response follows RFC 9457 with a `WWW-Authenticate`
 * header so the web client can trigger a Keycloak step-up redirect.
 *
 * The factory signature matches the pattern used by `requireFlag` so
 * routes can include it in `preHandler` arrays without an extra import
 * of the Fastify instance.
 */
export function requireBankMutationAcr(_fastify?: unknown) {
  return async function bankMutationAcrHook(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const auth = request.auth;

    // requireAuth must run before this guard — if auth is null, 401 is
    // already being sent. Defensive check in case the order is wrong.
    if (!auth) {
      void reply.header("WWW-Authenticate", 'Bearer acr_values="2"');
      return reply.status(401).send({
        type: "urn:givernance:error:step-up-required",
        title: "Step-up authentication required",
        status: 401,
        detail: "Bank account mutations require TOTP re-authentication within the last 15 minutes.",
        instance: request.url,
      });
    }

    const acr = auth.acr;
    const authTime = auth.authTime;

    // acr >= 2 — the LoA the realm issues and the web requests. Parsed
    // numerically so a future LoA 3 also satisfies a LoA-2 requirement.
    const acrLevel = Number.parseInt(String(acr ?? ""), 10);
    const hasRequiredAcr = Number.isFinite(acrLevel) && acrLevel >= 2;
    const nowSec = Math.floor(Date.now() / 1000);
    const authTimeAge = typeof authTime === "number" ? nowSec - authTime : null;
    // Reject a FUTURE auth_time as well as a stale one — a clock-skewed or
    // forged forward-dated claim must not buy an unbounded step-up window.
    const isRecent = authTimeAge !== null && authTimeAge >= 0 && authTimeAge < 900;

    if (!hasRequiredAcr || !isRecent) {
      request.log.warn(
        {
          event: "bank_mutation.step_up_required",
          acr: acr ?? null,
          authTime: authTime ?? null,
          authTimeAge: typeof authTime === "number" ? nowSec - authTime : null,
          url: request.url,
          userId: auth.userId,
          orgId: auth.orgId,
          reason: !hasRequiredAcr ? "acr_insufficient" : "auth_time_stale",
        },
        "Bank account mutation blocked — step-up ACR required",
      );
      void reply.header("WWW-Authenticate", 'Bearer acr_values="2"');
      return reply.status(401).send({
        type: "urn:givernance:error:step-up-required",
        title: "Step-up authentication required",
        status: 401,
        detail: "Bank account mutations require TOTP re-authentication within the last 15 minutes.",
        instance: request.url,
      });
    }

    // Step-up passed — emit a structured audit log line so the SIEM
    // can correlate bank-mutation events with the ACR claim that
    // authorised them, without having to reconstruct from raw JWT fields.
    request.log.info(
      {
        event: "bank_mutation.step_up_passed",
        acr,
        authTime,
        authTimeAge: nowSec - (authTime as number),
        url: request.url,
        userId: auth.userId,
        orgId: auth.orgId,
      },
      "Bank account mutation step-up ACR verified",
    );
  };
}

/** Constant-time string comparison to prevent timing attacks (M1 fix) */
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
