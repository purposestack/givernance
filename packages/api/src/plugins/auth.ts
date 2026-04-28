/** JWT validation plugin — verifies Keycloak-issued OIDC tokens against the realm JWKS. */

import { timingSafeEqual } from "node:crypto";

import cookie from "@fastify/cookie";
import type { AuthContext, UserRole } from "@givernance/shared";
import { users } from "@givernance/shared/schema";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { withTenantContext } from "../lib/db.js";
import { verifyKeycloakJwt } from "../lib/keycloak-jwt.js";
import { problemDetail } from "../lib/schemas.js";
import {
  getActiveUserCache,
  isSessionBlocklisted,
  isUserBlocklisted,
  setActiveUserCache,
} from "../modules/session/service.js";

const JWT_COOKIE_NAME = "givernance_jwt";
const CSRF_COOKIE_NAME = "csrf-token";
const CSRF_HEADER_NAME = "x-csrf-token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
    /** JWT `jti` claim — used by the session blocklist for `switch-org` revocations. */
    jwtJti: string | null;
    /** JWT `exp` (seconds-epoch) — used when blocklisting to TTL the key. */
    jwtExp: number | null;
  }
}

async function auth(app: FastifyInstance) {
  await app.register(cookie);

  /** Extract auth context from verified JWT claims */
  app.decorateRequest("auth", null);
  app.decorateRequest("jwtJti", null);
  app.decorateRequest("jwtExp", null);

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (isAuthExempt(request.url)) return;

    const tokenResult = await applyAuthFromToken(request);
    if (tokenResult === "session_revoked") {
      return reply.status(401).send(problemDetail(401, "Unauthorized", "Session revoked."));
    }
    if (tokenResult === "user_revoked") {
      // ADR-021 — the user's Keycloak `sub` was blocklisted at app
      // soft-delete time. The token is cryptographically valid but the
      // user is gone; reject before any handler can act on stale claims.
      return reply
        .status(401)
        .send(problemDetail(401, "Unauthorized", "Account no longer active."));
    }
    if (tokenResult === "no_active_membership") {
      // ADR-021 — the JWT carries an `org_id` but no active `users`
      // row exists for `(sub, org_id)`. This is the soft-delete path
      // where the token outlives the row, OR a stale JWT for a tenant
      // the user has been removed from. Reject so no tenant-scoped
      // route can run with a non-resolvable subject.
      return reply
        .status(401)
        .send(problemDetail(401, "Unauthorized", "Account no longer active."));
    }
    if (tokenResult === "no_org_claim") {
      // ADR-021 — the JWT has a `sub` but no `org_id` and no
      // `super_admin` realm role. Every tenant-scoped route would 500
      // trying to use `request.auth.orgId`; rejecting here surfaces a
      // clean 401 instead. Surfaced when a JWT was minted for a tenant
      // user whose tenant was lost (e.g. soft-deleted on every org
      // they belonged to).
      return reply.status(401).send(problemDetail(401, "Unauthorized", "No active organisation."));
    }

    if (!requiresCsrfCheck(request)) return;

    if (!csrfTokenValid(request)) {
      return reply
        .status(403)
        .send(problemDetail(403, "Forbidden", "Missing or invalid CSRF double-submit token"));
    }
  });
}

function isAuthExempt(url: string): boolean {
  return url.startsWith("/healthz") || url.startsWith("/readyz") || url.startsWith("/docs");
}

/**
 * Discriminated outcome of token validation. Each variant maps to a
 * distinct 401 response in the caller (ADR-021).
 *
 *   `"ok"` — JWT valid; `request.auth` populated.
 *   `"none"` — no token presented; route guards decide whether that's a 401.
 *   `"session_revoked"` — JTI on the session blocklist (switch-org revocation).
 *   `"user_revoked"` — `sub` on the user blocklist (post-soft-delete).
 *   `"no_active_membership"` — JWT carries `org_id` but no active `users` row resolves.
 *   `"no_org_claim"` — JWT has `sub` but no `org_id` and not a super_admin (tenant route would 500 on `orgId`).
 */
type TokenResult =
  | "ok"
  | "none"
  | "session_revoked"
  | "user_revoked"
  | "no_active_membership"
  | "no_org_claim";

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: applyAuthFromToken walks every reject branch (no token, signature fail, JTI blocklist, user blocklist, no-org sanity, active-row check) inline because each branch maps to a distinct 401 reason in the caller — splitting hides the dispatch.
async function applyAuthFromToken(request: FastifyRequest): Promise<TokenResult> {
  const token = extractToken(request);
  if (!token) return "none";

  let decoded: Awaited<ReturnType<typeof verifyKeycloakJwt>>;
  try {
    decoded = await verifyKeycloakJwt(token);
  } catch {
    // Invalid signature / expired / unparseable. Auth will be null,
    // route guards will 401 via the `requireAuth` path.
    return "none";
  }

  // Reject tokens revoked by a `switch-org` call (ADR-016 / doc 22 §6.3).
  // Blocklist check lives in Redis; a missing `jti` means the upstream
  // realm didn't emit one — the switch endpoint will still authorise
  // itself, but will not be able to revoke the prior session.
  if (decoded.jti && (await isSessionBlocklisted(decoded.jti))) {
    return "session_revoked";
  }

  // ADR-021 — user-ID blocklist. Closes the post-soft-delete window for
  // already-issued access tokens. Zero-second propagation; the entry
  // stays in Redis for the realm's max access-token TTL.
  if (await isUserBlocklisted(decoded.sub)) {
    return "user_revoked";
  }

  const realmRoles = decoded.realm_access?.roles ?? [];
  const isSuperAdmin = realmRoles.includes("super_admin");

  // ADR-021 — every authenticated request must satisfy ONE of:
  //   (a) super_admin (platform-level; no org binding by design), OR
  //   (b) `org_id` claim present AND active `users` row resolves.
  // Anything else is rejected here before `request.auth` is set so no
  // tenant-scoped route can run with a non-resolvable subject.
  if (!isSuperAdmin) {
    if (!decoded.org_id) return "no_org_claim";
    const isActive = await resolveActiveMembership(decoded.sub, decoded.org_id);
    if (!isActive) return "no_active_membership";
  }

  request.auth = {
    userId: decoded.sub,
    orgId: decoded.org_id,
    roles: realmRoles,
    email: decoded.email,
    role: decoded.role as UserRole | undefined,
    act: decoded.act,
  };
  request.jwtJti = decoded.jti ?? null;
  request.jwtExp = typeof decoded.exp === "number" ? decoded.exp : null;
  return "ok";
}

/**
 * Resolve whether a `(sub, orgId)` pair maps to an active `users` row
 * (ADR-021 active-row check). Reads through the Redis cache first; on
 * a miss, queries Postgres and writes the result. Cache TTL is short
 * (~30 s) so soft-delete propagates without explicit invalidation —
 * callers that want zero-second propagation should also call
 * `invalidateActiveUserCache` from the session-service module.
 */
async function resolveActiveMembership(sub: string, orgId: string): Promise<boolean> {
  const cached = await getActiveUserCache(sub, orgId);
  if (cached === "active") return true;
  if (cached === "missing") return false;

  // Cache miss — query the source of truth. Filtered by tenant via
  // RLS through `withTenantContext`; the `eq(orgId)` predicate is
  // belt-and-suspenders.
  //
  // We catch and swallow DB errors here: the auth plugin runs on every
  // authenticated request, and a DB blip during the active-row check
  // would otherwise turn into a 500 cascade. Fail-OPEN to "active" on
  // DB error so a transient outage doesn't lock everyone out — the
  // user blocklist and the JWT signature are still hard gates. A
  // structured error log gives ops visibility without breaking the
  // hot path.
  try {
    const rows = await withTenantContext(orgId, async (tx) =>
      tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.keycloakId, sub), eq(users.orgId, orgId), isNull(users.deletedAt)))
        .limit(1),
    );
    const isActive = rows.length > 0;
    await setActiveUserCache(sub, orgId, isActive ? "active" : "missing");
    return isActive;
  } catch (err) {
    // biome-ignore lint/suspicious/noConsole: structured logging plumbed via pino at the request scope; logger here is module-scoped
    console.error({ err, sub, orgId }, "auth: active-row resolution failed — failing open");
    return true;
  }
}

function requiresCsrfCheck(request: FastifyRequest): boolean {
  if (SAFE_METHODS.has(request.method)) return false;
  return Boolean(request.cookies[JWT_COOKIE_NAME]);
}

function csrfTokenValid(request: FastifyRequest): boolean {
  const csrfCookie = request.cookies[CSRF_COOKIE_NAME];
  const csrfHeader = request.headers[CSRF_HEADER_NAME];
  if (!csrfCookie || typeof csrfHeader !== "string") return false;
  return tokensMatch(csrfCookie, csrfHeader);
}

function tokensMatch(cookieValue: string, headerValue: string): boolean {
  const cookieToken = Buffer.from(cookieValue);
  const headerToken = Buffer.from(headerValue);

  if (cookieToken.length !== headerToken.length) {
    return false;
  }

  return timingSafeEqual(cookieToken, headerToken);
}

export const authPlugin = fp(auth, { name: "auth" });

function extractToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }

  return request.cookies[JWT_COOKIE_NAME] ?? null;
}
