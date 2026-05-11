/**
 * Feature flag evaluation service — Phase-1 MVP (global flags only).
 *
 * The whole registry lives in one Redis key, `flags:global`, stored as
 * a single JSON-serialised `Record<flagKey, boolean>`. Reads are
 * O(1); writes invalidate by overwriting the same key in one round-
 * trip. There are <10 flags expected in the foreseeable future, so a
 * full-map invalidate is cheaper to reason about than per-key keys.
 *
 * Why a single map + 60s TTL:
 *   - Misses fall through to PG → one query rebuilds the whole map,
 *     so a cold cache costs one round-trip not N.
 *   - 60s upper bound on staleness is acceptable for an operator-
 *     toggled flag — the admin UI also explicit-invalidates on write
 *     so a flip is visible immediately on the next request.
 *   - Unknown keys (typo / removed flag still referenced in old code)
 *     evaluate to `false`, matching doc 18 §5.
 *
 * Per-tenant overrides + plan-gating from doc 18 are intentionally
 * out of scope here — the function signature takes a `key` only, so
 * future tenant-overload won't break existing callers.
 */

import { featureFlags } from "@givernance/shared/schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type Redis from "ioredis";
import pino from "pino";
import { db } from "../db.js";
import { redis as defaultRedis } from "../redis.js";

const logger = pino({ name: "flag-service" });

const CACHE_KEY = "flags:global";
const CACHE_TTL_SECONDS = 60;

/** Strict registry shape — only the columns the evaluator + admin UI need. */
export interface FeatureFlagRow {
  key: string;
  enabled: boolean;
  description: string;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Test-seam: the production code uses the module-level `db` / `redis`
 * singletons. Tests inject their own to assert the cache-miss → PG
 * fallback behaviour without mocking the imports.
 */
export interface FlagServiceDeps {
  // biome-ignore lint/suspicious/noExplicitAny: NodePgDatabase is generic over the schema; we don't need to narrow inside the service
  db?: NodePgDatabase<any>;
  redis?: Redis;
}

function getDb(deps: FlagServiceDeps): NodePgDatabase<Record<string, never>> {
  return (deps.db ?? db) as NodePgDatabase<Record<string, never>>;
}

function getRedis(deps: FlagServiceDeps): Redis {
  return deps.redis ?? defaultRedis;
}

/**
 * Read every flag row from PG and return them as a `key → enabled`
 * map. Used internally on cache miss; also exposed for the admin
 * list endpoint (read-through behaviour is the same).
 */
async function loadFromDb(
  conn: NodePgDatabase<Record<string, never>>,
): Promise<Record<string, boolean>> {
  const rows = await conn
    .select({ key: featureFlags.key, enabled: featureFlags.enabled })
    .from(featureFlags);
  const map: Record<string, boolean> = {};
  for (const row of rows) {
    map[row.key] = row.enabled;
  }
  return map;
}

async function getMap(deps: FlagServiceDeps = {}): Promise<Record<string, boolean>> {
  const cache = getRedis(deps);
  try {
    const cached = await cache.get(CACHE_KEY);
    if (cached) {
      return JSON.parse(cached) as Record<string, boolean>;
    }
  } catch (err) {
    // Cache failure must NOT crash flag evaluation — fall through to
    // PG. A Redis outage already manifests as elevated p99 (cache
    // misses); we don't want to also flip every gated route to 404.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "flags: cache read failed, falling back to PG",
    );
  }

  const map = await loadFromDb(getDb(deps));

  try {
    await cache.set(CACHE_KEY, JSON.stringify(map), "EX", CACHE_TTL_SECONDS);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "flags: cache write failed, evaluator will keep falling through to PG until Redis recovers",
    );
  }

  return map;
}

export interface FlagService {
  /**
   * Evaluate a single flag. Unknown keys (typo / DB drift) evaluate
   * to `false` per doc 18 §5 — never throws, never returns null. Any
   * unexpected DB error bubbles up; the route layer's existing 500
   * handler catches it.
   */
  isEnabled(key: string): Promise<boolean>;
  /** Bulk fetch — used by the admin list endpoint + the web SSR layer. */
  list(): Promise<FeatureFlagRow[]>;
  /**
   * Invalidate the Redis cache. Called by the admin PATCH route AFTER
   * the DB write succeeds so the next read sees the new value.
   * Idempotent — a stale del on a key that's already gone is a no-op.
   */
  invalidate(): Promise<void>;
}

/**
 * Build a `FlagService` bound to the supplied (or default) db + redis
 * handles. Each Fastify request decorates a fresh instance via the
 * plugin below so per-request mocking stays cheap.
 */
export function createFlagService(deps: FlagServiceDeps = {}): FlagService {
  return {
    async isEnabled(key) {
      const map = await getMap(deps);
      return map[key] === true;
    },
    async list() {
      const rows = await getDb(deps)
        .select({
          key: featureFlags.key,
          enabled: featureFlags.enabled,
          description: featureFlags.description,
          updatedBy: featureFlags.updatedBy,
          createdAt: featureFlags.createdAt,
          updatedAt: featureFlags.updatedAt,
        })
        .from(featureFlags)
        .orderBy(featureFlags.key);
      return rows.map((row) => ({
        key: row.key,
        enabled: row.enabled,
        description: row.description,
        updatedBy: row.updatedBy,
        createdAt:
          row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
        updatedAt:
          row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
      }));
    },
    async invalidate() {
      try {
        await getRedis(deps).del(CACHE_KEY);
      } catch (err) {
        // Same posture as the read path — log + continue. The 60-second
        // TTL is the worst-case lag between admin flip and observable
        // effect; if Redis is down the admin sees their change on the
        // next request anyway (PG read-through).
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "flags: cache invalidate failed, value will refresh within TTL",
        );
      }
    },
  };
}

/**
 * Default singleton for non-request code (workers, scripts). Inside
 * Fastify routes prefer `request.flagService` so per-test injection
 * stays cheap.
 */
export const flagService: FlagService = createFlagService();
