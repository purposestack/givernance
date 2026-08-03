/**
 * Session service — org picker + switch-org (issue #112 / ADR-016 / doc 22 §6.3, §7).
 *
 * Scope:
 *  - `listUserOrganizations` enumerates the tenants the calling user belongs
 *    to, by the Keycloak `sub` claim. Cross-tenant query → owner role, no
 *    `withTenantContext`. Returns role + last-visited metadata for the
 *    picker card sort.
 *  - `recordOrgSwitch` validates membership of the target tenant, updates
 *    `last_visited_at`, blocklists the previous access token's `jti` and
 *    emits audit + outbox events.
 *
 * The actual token re-minting (Keycloak token-exchange) is wired on the
 * Next.js API side in `/api/auth/switch-org`; this service is the trusted
 * authority that authorises the switch and records it.
 */

import {
  auditLogs,
  type OutboxMetadata,
  outboxEvents,
  tenants,
  users,
} from "@givernance/shared/schema";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import pino from "pino";
import { env } from "../../env.js";
import { systemDb, withTenantContext } from "../../lib/db.js";
import { redis } from "../../lib/redis.js";
import { buildOutboxMetadata } from "../../lib/trace-context.js";

const logger = pino({ name: "session", level: env.LOG_LEVEL });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OrgMembership {
  orgId: string;
  slug: string;
  name: string;
  status: string;
  role: string;
  firstAdmin: boolean;
  provisionalUntil: string | null;
  primaryDomain: string | null;
  lastVisitedAt: string | null;
}

/**
 * List every tenant the user belongs to (by Keycloak `sub`). Suspended /
 * archived tenants are excluded so a revoked org never shows in the picker.
 *
 * Cross-tenant by design — runs on the owner role (`systemDb`, BYPASSRLS).
 * Using the app-role pool would silently return zero rows because no
 * `app.current_organization_id` is set: the whole point of this query is
 * to enumerate ALL tenants the caller belongs to, before any single
 * tenant context exists. The `keycloakSub` is the security boundary
 * (sourced from a verified JWT in the route handler), not RLS.
 */
export async function listUserOrganizations(keycloakSub: string): Promise<OrgMembership[]> {
  const rows = await systemDb
    .select({
      orgId: tenants.id,
      slug: tenants.slug,
      name: tenants.name,
      status: tenants.status,
      role: users.role,
      firstAdmin: users.firstAdmin,
      provisionalUntil: users.provisionalUntil,
      primaryDomain: tenants.primaryDomain,
      lastVisitedAt: users.lastVisitedAt,
    })
    .from(users)
    .innerJoin(tenants, eq(users.orgId, tenants.id))
    .where(and(eq(users.keycloakId, keycloakSub), sql`${tenants.status} <> 'archived'`))
    .orderBy(sql`${users.lastVisitedAt} DESC NULLS LAST`, sql`${tenants.name} ASC`);

  return rows.map((r) => ({
    orgId: r.orgId,
    slug: r.slug,
    name: r.name,
    status: r.status,
    role: r.role,
    firstAdmin: r.firstAdmin,
    provisionalUntil: r.provisionalUntil?.toISOString() ?? null,
    primaryDomain: r.primaryDomain,
    lastVisitedAt: r.lastVisitedAt?.toISOString() ?? null,
  }));
}

export type SwitchOrgResult =
  | {
      ok: true;
      targetOrgId: string;
      targetSlug: string;
      targetRole: string;
    }
  | {
      ok: false;
      error: "not_a_member" | "target_not_found" | "target_suspended" | "target_archived";
    };

export interface SwitchOrgInput {
  keycloakSub: string;
  targetOrgId: string;
  /** Previous access-token `jti` — blocklisted on success (session revocation). */
  previousJti?: string;
  /** JWT `exp` (seconds-epoch) of the previous access token — used to TTL the blocklist. */
  previousExp?: number;
  /** If the caller currently has an impersonation `act` claim, the switch must be refused. */
  isImpersonating?: boolean;
  audit: {
    ipHash?: string;
    userAgent?: string;
  };
}

/**
 * Validate membership of the target tenant and record the switch. Writes
 * `last_visited_at`, audit, outbox. Blocklists the previous JWT (if any) so
 * that — once the front-door auth middleware consults the blocklist — the
 * old cookie can no longer be used to read the previous tenant's data.
 */
export async function recordOrgSwitch(
  input: SwitchOrgInput,
  request?: FastifyRequest,
): Promise<SwitchOrgResult> {
  if (!UUID_RE.test(input.targetOrgId)) return { ok: false, error: "target_not_found" };
  if (input.isImpersonating) {
    // Per ADR-016 / doc 22 §8: switch-org terminates impersonation. We return
    // `not_a_member` so the caller is forced through /api/auth/logout first;
    // a dedicated error code exposes the impersonation boundary externally,
    // which we explicitly do not want to do.
    return { ok: false, error: "not_a_member" };
  }

  // Cross-tenant membership probe — same rationale as `listUserOrganizations`
  // above: the caller hasn't entered the target tenant yet, so we have no
  // `app.current_organization_id` to set. The `(keycloakSub, targetOrgId)`
  // pair is the authority gate. Subsequent writes use `withTenantContext`
  // once the tenant is resolved, so RLS still isolates the audit/outbox
  // inserts.
  const [target] = await systemDb
    .select({
      orgId: tenants.id,
      slug: tenants.slug,
      status: tenants.status,
      role: users.role,
      userId: users.id,
    })
    .from(users)
    .innerJoin(tenants, eq(users.orgId, tenants.id))
    .where(and(eq(users.keycloakId, input.keycloakSub), eq(users.orgId, input.targetOrgId)))
    .limit(1);

  if (!target) return { ok: false, error: "not_a_member" };
  if (target.status === "suspended") return { ok: false, error: "target_suspended" };
  if (target.status === "archived") return { ok: false, error: "target_archived" };

  // W3C trace-context → outbox metadata (issue #55); null outside an HTTP request.
  const metadata: OutboxMetadata | null = request ? buildOutboxMetadata(request) : null;

  await withTenantContext(target.orgId, async (tx) => {
    await tx
      .update(users)
      .set({ lastVisitedAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, target.userId));

    await tx.insert(auditLogs).values({
      orgId: target.orgId,
      userId: target.userId,
      action: "session.switch_org",
      resourceType: "session",
      resourceId: target.orgId,
      newValues: { targetSlug: target.slug, role: target.role },
      ipHash: input.audit.ipHash,
      userAgent: input.audit.userAgent,
    });

    await tx.insert(outboxEvents).values({
      tenantId: target.orgId,
      type: "session.switched",
      payload: { userId: target.userId, targetSlug: target.slug },
      metadata,
    });
  });

  // Blocklist the previous token. TTL the key until the token's natural exp
  // so we don't accumulate garbage past the moment the token would fail
  // verification anyway. Clamp to a 24h max as defence-in-depth.
  if (input.previousJti) {
    const nowS = Math.floor(Date.now() / 1000);
    const ttlS = input.previousExp && input.previousExp > nowS ? input.previousExp - nowS : 3600;
    const clamped = Math.min(Math.max(ttlS, 60), 24 * 3600);
    await redis.setex(sessionBlocklistKey(input.previousJti), clamped, "1");
  }

  return {
    ok: true,
    targetOrgId: target.orgId,
    targetSlug: target.slug,
    targetRole: target.role,
  };
}

/** Redis key for a blocklisted JWT `jti`. */
export function sessionBlocklistKey(jti: string): string {
  return `session:blocklist:${jti}`;
}

/**
 * DATA-5 (PR #118 review): on Redis outage we **fail closed** — a 500-level
 * blip in Redis would otherwise silently accept a revoked token. Returning
 * `true` here means the caller gets a 401 "session revoked" until Redis is
 * back; that surfaces the dependency clearly on the observability stack
 * rather than degrading auth silently.
 */
export async function isSessionBlocklisted(jti: string | undefined): Promise<boolean> {
  if (!jti) return false;
  try {
    const hit = await redis.get(sessionBlocklistKey(jti));
    return hit !== null;
  } catch (err) {
    logger.error({ err, jti }, "session blocklist lookup failed — failing closed");
    return true;
  }
}

// ─── User-ID blocklist + active-row cache (ADR-021) ──────────────────────────
//
// `DELETE /v1/users/:id` blocklists the user's Keycloak `sub` so any of
// their already-issued access tokens are rejected at the auth boundary
// even though the JWT signature still validates. This closes the window
// between application soft-delete and access-token expiry. The blocklist
// also short-circuits the per-request active-row lookup for revoked
// users — see `isUserBlocklisted` below.
//
// The active-row cache (`auth:active-user:<sub>:<orgId>`) memoises the
// "this JWT subject corresponds to an active `users` row in this org"
// answer for ~30s so the auth plugin doesn't hit Postgres on every call.
// A miss falls through to a DB query and writes the result; a soft-delete
// invalidates the key so the next request observes the new state.

const USER_BLOCKLIST_PREFIX = "auth:user-blocklist:";
const ACTIVE_USER_CACHE_PREFIX = "auth:active-user:";
/** Default TTL for the active-row cache. Soft-delete invalidates the key directly. */
export const ACTIVE_USER_CACHE_TTL_SECONDS = 30;

function userBlocklistKey(keycloakId: string): string {
  return `${USER_BLOCKLIST_PREFIX}${keycloakId}`;
}

function activeUserCacheKey(keycloakId: string, orgId: string): string {
  return `${ACTIVE_USER_CACHE_PREFIX}${keycloakId}:${orgId}`;
}

/**
 * Mark a Keycloak `sub` as revoked. Used by `DELETE /v1/users/:id` to
 * close the access-token-TTL window after the application soft-delete.
 * `ttlSeconds` should be at least the realm's max access-token TTL
 * (default 1 hour for Givernance — generous so the entry is gone well
 * after any access token would naturally expire).
 */
export async function blocklistUser(keycloakId: string, ttlSeconds = 3600): Promise<void> {
  await redis.setex(userBlocklistKey(keycloakId), Math.max(ttlSeconds, 1), "1");
}

/**
 * Returns `true` when the user's Keycloak `sub` was blocklisted (e.g. by
 * a soft-delete). Same fail-closed semantics as `isSessionBlocklisted`:
 * a Redis blip surfaces as 401, not silent accept.
 */
export async function isUserBlocklisted(keycloakId: string | undefined): Promise<boolean> {
  if (!keycloakId) return false;
  try {
    const hit = await redis.get(userBlocklistKey(keycloakId));
    return hit !== null;
  } catch (err) {
    logger.error({ err, keycloakId }, "user blocklist lookup failed — failing closed");
    return true;
  }
}

/**
 * Look up the active-row cache. Returns either:
 *   - `{ active: true, userRowId }` — a `users` row exists for
 *     `(keycloak_id, org_id)` with `deleted_at IS NULL`; row UUID cached
 *     so call sites that need `users.id` (e.g. notifications routes
 *     filtering against `notifications.user_id`) don't re-query.
 *   - `"missing"` — no active row (cached negative).
 *   - `null` — not in cache; caller should query Postgres.
 *
 * The cache is intentionally short-TTL so a soft-delete propagates without
 * needing a fanout invalidation; for zero-second propagation use the
 * `blocklistUser` path which closes the door immediately.
 *
 * Cache value encoding:
 *   - `"0"` ⇒ missing (negative cache, legacy compat)
 *   - any other non-empty string ⇒ `users.id` row UUID (positive cache)
 *
 * The old `"1"` positive value (pre-Epic-#363 GLO-004 fix) is treated as
 * a cache miss so an in-flight rolling deploy on top of a stale Redis
 * doesn't hand callers a `userRowId` of `"1"`.
 */
export async function getActiveUserCache(
  keycloakId: string,
  orgId: string,
): Promise<{ active: true; userRowId: string } | "missing" | null> {
  try {
    const hit = await redis.get(activeUserCacheKey(keycloakId, orgId));
    if (hit === null) return null;
    if (hit === "0") return "missing";
    // Reject the pre-fix `"1"` positive value and any other shape that
    // isn't a UUID — a "1" handed back as `userRowId` would silently
    // re-introduce the bug on tenant routes filtering by `users.id`.
    if (hit === "1" || !UUID_RE.test(hit)) return null;
    return { active: true, userRowId: hit };
  } catch (err) {
    logger.error({ err, keycloakId, orgId }, "active-user cache read failed");
    return null;
  }
}

/**
 * Write the cache with a short TTL after a successful (or negative) DB
 * lookup. `userRowId` is the `users.id` row UUID when active, omitted
 * for the negative case.
 */
export async function setActiveUserCache(
  keycloakId: string,
  orgId: string,
  result: { active: true; userRowId: string } | { active: false },
  ttlSeconds = ACTIVE_USER_CACHE_TTL_SECONDS,
): Promise<void> {
  try {
    const value = result.active ? result.userRowId : "0";
    await redis.setex(activeUserCacheKey(keycloakId, orgId), ttlSeconds, value);
  } catch (err) {
    logger.error({ err, keycloakId, orgId }, "active-user cache write failed");
  }
}

/** Drop the cache for a (sub, orgId) pair after a soft-delete or rejoin. */
export async function invalidateActiveUserCache(keycloakId: string, orgId: string): Promise<void> {
  try {
    await redis.del(activeUserCacheKey(keycloakId, orgId));
  } catch (err) {
    logger.error({ err, keycloakId, orgId }, "active-user cache invalidation failed");
  }
}

// ─── Keycloak SSO session blocklist (issue #76 / PR-2) ─────────────────────
//
// Distinct from the `jti` blocklist above: this one keys on the OIDC `sid`
// claim, which is stable across access-token refreshes for the same
// upstream Keycloak session. Used by the back-channel logout webhook —
// when Keycloak notifies us that an upstream session has ended (admin
// "Sign out all sessions", sibling-device logout), we blocklist the `sid`
// so any access token still carrying it gets rejected on the next request
// instead of remaining valid until natural expiry.
//
// Fail-closed on Redis outage matches `isSessionBlocklisted` /
// `isUserBlocklisted` — a transient Redis blip surfaces as 401 rather
// than silently accepting tokens we cannot vouch for.

const KEYCLOAK_SID_BLOCKLIST_PREFIX = "auth:kc-sid-blocklist:";
/**
 * Default blocklist TTL — must outlive the longest access token Keycloak
 * might mint after the back-channel signal arrives. The realm currently
 * sets `access.token.lifespan=300` (5 minutes — issue #76 / PR-3) so 10
 * minutes gives generous headroom for clock skew without leaving stale
 * entries around. Callers can pass an explicit TTL when they know better.
 */
export const KEYCLOAK_SID_BLOCKLIST_DEFAULT_TTL_S = 10 * 60;

function keycloakSessionBlocklistKey(sid: string): string {
  return `${KEYCLOAK_SID_BLOCKLIST_PREFIX}${sid}`;
}

/**
 * Mark a Keycloak SSO session id as revoked. Called by the back-channel
 * logout webhook after the logout token is signature-verified. `ttlSeconds`
 * should cover the longest still-valid access token that could carry this
 * `sid`; the default tracks the realm's `access.token.lifespan` with a
 * skew buffer.
 */
export async function blocklistKeycloakSession(
  sid: string,
  ttlSeconds: number = KEYCLOAK_SID_BLOCKLIST_DEFAULT_TTL_S,
): Promise<void> {
  await redis.setex(keycloakSessionBlocklistKey(sid), Math.max(ttlSeconds, 1), "1");
}

export async function isKeycloakSessionBlocklisted(sid: string | undefined): Promise<boolean> {
  if (!sid) return false;
  try {
    const hit = await redis.get(keycloakSessionBlocklistKey(sid));
    return hit !== null;
  } catch (err) {
    logger.error({ err, sid }, "keycloak-session blocklist lookup failed — failing closed");
    return true;
  }
}
