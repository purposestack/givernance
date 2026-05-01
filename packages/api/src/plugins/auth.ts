/** JWT validation plugin — verifies Keycloak-issued OIDC tokens against the realm JWKS. */

import { timingSafeEqual } from "node:crypto";

import cookie from "@fastify/cookie";
import type { AuthContext, UserRole } from "@givernance/shared";
import { users } from "@givernance/shared/schema";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { withTenantContext } from "../lib/db.js";
import { looksLikeImpersonationToken, verifyImpersonationToken } from "../lib/impersonation/jwt.js";
import { getActiveSession } from "../lib/impersonation/redis-store.js";
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
    if (tokenResult === "impersonation_revoked") {
      // Issue #24 — the impersonation session was ended/revoked since the
      // cookie was issued. Distinct response from `session_revoked` so the
      // banner-end flow can detect "your session is gone, drop the cookie"
      // and the audit log can attribute correctly.
      return reply
        .status(401)
        .send(problemDetail(401, "Unauthorized", "Impersonation session ended or expired."));
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
 * Normalise OIDC `acr` to a scalar string. Keycloak occasionally emits
 * `["2"]` instead of `"2"` depending on broker / RequestedLevelOfAssurance
 * configuration — without this normalisation the impersonation step-up
 * validator would reject legitimate MFA-backed tokens (issue #24, review H2).
 */
function normaliseAcr(raw: unknown): string | undefined {
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === "string") return raw[0];
  return undefined;
}

/**
 * Discriminated outcome of token validation. Each variant maps to a
 * distinct 401 response in the caller (ADR-021).
 *
 *   `"ok"` — JWT valid; `request.auth` populated.
 *   `"none"` — no token presented OR token rejected by `verifyKeycloakJwt`
 *     (bad signature, expired, missing `sub` / `org_id` / `email`); route
 *     guards 401 via the `requireAuth` path with "Authentication required."
 *   `"session_revoked"` — JTI on the session blocklist (switch-org revocation).
 *   `"user_revoked"` — `sub` on the user blocklist (post-soft-delete).
 *   `"no_active_membership"` — JWT carries `org_id` but no active `users` row resolves.
 *
 * Note on the absent `no_org_claim` discriminator: `verifyKeycloakJwt`
 * already requires `org_id` to be present (every Keycloak token in this
 * realm carries it; super_admin tokens too — they reuse a placeholder
 * tenant id since the realm mapper can't omit the claim). A JWT without
 * `org_id` is rejected upstream and surfaces here as `"none"`.
 */
type TokenResult =
  | "ok"
  | "none"
  | "session_revoked"
  | "user_revoked"
  | "no_active_membership"
  | "impersonation_revoked";

async function applyAuthFromToken(request: FastifyRequest): Promise<TokenResult> {
  const token = extractToken(request);
  if (!token) return "none";

  // Issue #24 — impersonation tokens carry a distinct `iss` so we route
  // them through their own verifier (HS256 + Redis active-session check)
  // instead of feeding them through the realm JWKS. The `iss` peek is
  // unverified (signature is checked inside verifyImpersonationToken), so
  // a normal Keycloak token spoofing the issuer string just falls into
  // the failure branch below.
  if (looksLikeImpersonationToken(token)) {
    return applyImpersonationFromToken(request, token);
  }

  let decoded: Awaited<ReturnType<typeof verifyKeycloakJwt>>;
  try {
    decoded = await verifyKeycloakJwt(token);
  } catch {
    // Invalid signature / expired / unparseable / missing `sub` / `org_id`
    // / `email`. Auth will be null, route guards will 401 via the
    // `requireAuth` path with "Authentication required."
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

  // ADR-021 — active-row check for tenant-scoped principals. Super_admin
  // is platform-level (no app-side users row required), so it's
  // exempted; everyone else must resolve an active `users` row for
  // `(sub, org_id)`. Closes the soft-delete + tenant-removal window
  // where the JWT is still cryptographically valid but the subject is
  // gone.
  if (!isSuperAdmin) {
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
    authTime: typeof decoded.auth_time === "number" ? decoded.auth_time : undefined,
    acr: normaliseAcr(decoded.acr),
  };
  request.jwtJti = decoded.jti ?? null;
  request.jwtExp = typeof decoded.exp === "number" ? decoded.exp : null;
  return "ok";
}

/**
 * Verify and apply an app-layer impersonation token (issue #24). Distinct
 * code path from the Keycloak verifier because:
 *   - signature is HS256 against IMPERSONATION_JWT_SECRET, not the realm JWKS
 *   - the session must still be active in Redis (instant revocation)
 *   - `request.auth.impersonation` carries the mode discriminator that the
 *     impersonation plugin reads to decide whether to block writes
 */
async function applyImpersonationFromToken(
  request: FastifyRequest,
  token: string,
): Promise<TokenResult> {
  let decoded: Awaited<ReturnType<typeof verifyImpersonationToken>>;
  try {
    decoded = await verifyImpersonationToken(token);
  } catch {
    return "none";
  }

  const session = await getActiveSession(decoded.imp_session_id);
  if (!session) {
    // Token is cryptographically valid but Redis says the session is gone
    // (DELETE, REVOKE, or expired-and-evicted). Return a distinct discriminator
    // so the response message is precise and audit can attribute correctly.
    return "impersonation_revoked";
  }

  // Cross-check critical claims against the Redis record — defense in depth
  // against a stolen token whose signing secret leaked. The session record
  // is rewritten on every start, so any drift here is an integrity violation.
  if (
    session.targetKeycloakId !== decoded.sub ||
    session.targetOrgId !== decoded.org_id ||
    session.mode !== decoded.imp_mode ||
    session.impersonatorKeycloakId !== decoded.act.sub
  ) {
    request.log.warn(
      {
        sessionId: decoded.imp_session_id,
        jwt: {
          sub: decoded.sub,
          org_id: decoded.org_id,
          mode: decoded.imp_mode,
          actor: decoded.act.sub,
        },
        redis: {
          sub: session.targetKeycloakId,
          org_id: session.targetOrgId,
          mode: session.mode,
          actor: session.impersonatorKeycloakId,
        },
      },
      "impersonation: token/session field mismatch — rejecting",
    );
    return "impersonation_revoked";
  }

  request.auth = {
    userId: decoded.sub,
    orgId: decoded.org_id,
    roles: decoded.realm_access.roles,
    email: decoded.email,
    role: decoded.role as UserRole | undefined,
    act: decoded.act,
    impersonation: {
      sessionId: decoded.imp_session_id,
      mode: decoded.imp_mode,
      reason: decoded.imp_reason,
      expiresAt: decoded.exp,
    },
  };
  request.jwtJti = decoded.jti;
  request.jwtExp = decoded.exp;
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
