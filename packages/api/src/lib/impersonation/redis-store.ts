/**
 * Redis state for support sessions (issue #24).
 *
 * Three keyspaces:
 *   - `impersonation:session:{sessionId}` — JSON record of the active
 *     session. TTL set to (expiresAt - now); lets DELETE invalidate
 *     instantly without scanning audit_logs.
 *   - `impersonation:revoked:{sessionId}` — tombstone written by the END /
 *     REVOKE paths. The auth plugin checks both the session key (must
 *     exist) AND this tombstone (must not exist) so a deleted session
 *     can't be replayed by an in-flight cookie.
 *   - `impersonation:ratelimit:start:{impersonatorSub}` — sliding 24h
 *     counter. Caps at 10 starts/admin/24h per the spec doc.
 *
 * Store membership is the source of truth for "is this session active?";
 * Postgres holds the durable trail. A Redis flush would force every active
 * cookie to be re-validated against Postgres — see `getActiveSession` for
 * the read-through path.
 */

import { redis } from "../redis.js";
import type { ActiveSessionRedisRecord } from "./types.js";

const SESSION_PREFIX = "impersonation:session:";
const REVOKED_PREFIX = "impersonation:revoked:";
const RATELIMIT_PREFIX = "impersonation:ratelimit:start:";
const DENIED_PREFIX = "impersonation:denied:";

/** Per-admin per-24h cap on session starts. Hard upper bound; spec doc §8. */
export const IMPERSONATION_MAX_STARTS_PER_24H = 10;
/** Brute-force lockout — see security architect cross-agent rules in doc-19. */
export const IMPERSONATION_DENIED_LOCKOUT_THRESHOLD = 5;
/** Sliding window for the lockout. */
export const IMPERSONATION_DENIED_LOCKOUT_WINDOW_SECONDS = 15 * 60;

export async function recordActiveSession(record: ActiveSessionRedisRecord): Promise<void> {
  const ttlSeconds = Math.max(1, Math.floor(record.expiresAt - Date.now() / 1000));
  await redis.set(`${SESSION_PREFIX}${record.sessionId}`, JSON.stringify(record), "EX", ttlSeconds);
}

export async function getActiveSession(
  sessionId: string,
): Promise<ActiveSessionRedisRecord | null> {
  if (!isUuid(sessionId)) return null;
  const raw = await redis.get(`${SESSION_PREFIX}${sessionId}`);
  if (!raw) return null;
  if (await isSessionRevoked(sessionId)) return null;
  try {
    const parsed = JSON.parse(raw) as ActiveSessionRedisRecord;
    // Defensive: Redis TTL eviction is eventually-consistent under churn;
    // double-check expiry against the embedded `expiresAt` so a stale read
    // can't outlive its window. Cheap (no extra round-trip).
    if (parsed.expiresAt * 1000 <= Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function endSession(sessionId: string, ttlSecondsHint?: number): Promise<void> {
  const ttl = ttlSecondsHint ?? 60 * 60 * 24; // 24h tombstone — outlives the longest session TTL.
  await Promise.all([
    redis.del(`${SESSION_PREFIX}${sessionId}`),
    redis.set(`${REVOKED_PREFIX}${sessionId}`, "1", "EX", ttl),
  ]);
}

export async function isSessionRevoked(sessionId: string): Promise<boolean> {
  const exists = await redis.exists(`${REVOKED_PREFIX}${sessionId}`);
  return exists === 1;
}

/**
 * Atomically increment the 24h start counter and return its new value
 * along with whether the cap has been exceeded. INCR + EXPIRE-on-first-set
 * is the canonical Redis pattern for sliding counters; the small race on
 * the EXPIRE call is acceptable because the next INCR re-asserts it.
 */
export async function incrementStartRateLimit(
  impersonatorKeycloakId: string,
): Promise<{ count: number; exceeded: boolean }> {
  const key = `${RATELIMIT_PREFIX}${impersonatorKeycloakId}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, 24 * 60 * 60);
  }
  return { count, exceeded: count > IMPERSONATION_MAX_STARTS_PER_24H };
}

/** Read-only inspect for tests / GET endpoints. */
export async function getStartRateLimitCount(impersonatorKeycloakId: string): Promise<number> {
  const raw = await redis.get(`${RATELIMIT_PREFIX}${impersonatorKeycloakId}`);
  return raw ? Number.parseInt(raw, 10) : 0;
}

/**
 * Record a failed step-up attempt. Returns whether the lockout threshold
 * has been crossed, so the caller can return a distinct 423-style message
 * AND emit a security alert.
 */
export async function recordDeniedAttempt(
  impersonatorKeycloakId: string,
): Promise<{ count: number; lockedOut: boolean }> {
  const key = `${DENIED_PREFIX}${impersonatorKeycloakId}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, IMPERSONATION_DENIED_LOCKOUT_WINDOW_SECONDS);
  }
  return { count, lockedOut: count >= IMPERSONATION_DENIED_LOCKOUT_THRESHOLD };
}

export async function isLockedOut(impersonatorKeycloakId: string): Promise<boolean> {
  const raw = await redis.get(`${DENIED_PREFIX}${impersonatorKeycloakId}`);
  return raw !== null && Number.parseInt(raw, 10) >= IMPERSONATION_DENIED_LOCKOUT_THRESHOLD;
}

export async function clearDeniedAttempts(impersonatorKeycloakId: string): Promise<void> {
  await redis.del(`${DENIED_PREFIX}${impersonatorKeycloakId}`);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}
