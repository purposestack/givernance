/**
 * Feature flag evaluation service — Phase 2 (Epic #365).
 *
 * Evaluation precedence (highest wins) per doc 18 § 5:
 *
 *   1. Unknown key                       → false  (typo / removed flag)
 *   2. `scope='platform'`                → `enabled` from `feature_flags`
 *                                          (tenant overrides ignored)
 *   3. `scope='tenant'` + tenant ctx     → override row if present,
 *                                          else `enabled` from `feature_flags`
 *   4. `scope='tenant'` + no tenant ctx  → `enabled` from `feature_flags`
 *                                          (worker / platform path)
 *
 * Cache topology:
 *   - `flags:global:v2` — full map keyed by flag key, value `{ enabled,
 *     scope }`. v2 because the Phase-1 shape was `Record<key, boolean>`
 *     and the evaluator now needs the scope to decide whether to
 *     consult the override cache.
 *   - `flags:tenant:{orgId}:v1` — Map<key, boolean> of overrides for
 *     that tenant. Empty (or missing) means no overrides — fall back
 *     to the platform default.
 *
 * Both caches have a 60s TTL; the admin PATCH / PUT / DELETE routes
 * call `invalidate()` / `invalidateTenant(orgId)` explicitly so a
 * flip is visible on the next request, not waiting on TTL.
 *
 * Unknown keys still evaluate to `false` per doc 18 § 5 — never
 * throws, never returns null.
 */

import { featureFlags, tenantFlagOverrides, tenants } from "@givernance/shared/schema";
import { and, count, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type Redis from "ioredis";
import pino from "pino";
import { db } from "../db.js";
import { redis as defaultRedis } from "../redis.js";

const logger = pino({ name: "flag-service" });

const GLOBAL_CACHE_KEY = "flags:global:v2";
const TENANT_CACHE_PREFIX = "flags:tenant:";
const TENANT_CACHE_SUFFIX = ":v1";
const CACHE_TTL_SECONDS = 60;

function tenantCacheKey(orgId: string): string {
  return `${TENANT_CACHE_PREFIX}${orgId}${TENANT_CACHE_SUFFIX}`;
}

/** Internal cache shape — what each flag row contributes to evaluation. */
interface GlobalFlagSummary {
  enabled: boolean;
  scope: "platform" | "tenant";
}

/** Strict registry shape — what the admin UI + list endpoints render. */
export interface FeatureFlagRow {
  key: string;
  enabled: boolean;
  label: string;
  description: string;
  scope: "platform" | "tenant";
  tenantOverrideAllowed: boolean;
  public: boolean;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Per-tenant override row as exposed to the admin/org-admin pages. */
export interface TenantFlagOverrideRow {
  tenantId: string;
  flagKey: string;
  value: boolean;
  reason: string | null;
  setBy: string | null;
  setAt: string;
}

/**
 * One row of the "tenants per flag" listing — drives the new
 * `/admin/feature-flags/[key]` multi-tenant management page
 * (Epic #365 / PR #366 — added after the reviewer flagged that
 * navigating individual `/admin/tenants/[id]` pages to manage
 * "5 enabled / 40 disabled" was impractical).
 */
export interface FlagTenantRow {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  /** Override row when present, null when the tenant uses the platform default. */
  override: TenantFlagOverrideRow | null;
  /** Effective value for this tenant — override.value if set, else flag's platform default. */
  effectiveValue: boolean;
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

/** Read every flag row from PG and project to the evaluator's summary shape. */
async function loadGlobalFromDb(
  conn: NodePgDatabase<Record<string, never>>,
): Promise<Record<string, GlobalFlagSummary>> {
  const rows = await conn
    .select({ key: featureFlags.key, enabled: featureFlags.enabled, scope: featureFlags.scope })
    .from(featureFlags);
  const map: Record<string, GlobalFlagSummary> = {};
  for (const row of rows) {
    map[row.key] = { enabled: row.enabled, scope: row.scope };
  }
  return map;
}

/** Read every override for a tenant. Returns an empty object if no rows. */
async function loadTenantFromDb(
  conn: NodePgDatabase<Record<string, never>>,
  orgId: string,
): Promise<Record<string, boolean>> {
  const rows = await conn
    .select({ flagKey: tenantFlagOverrides.flagKey, value: tenantFlagOverrides.value })
    .from(tenantFlagOverrides)
    .where(eq(tenantFlagOverrides.tenantId, orgId));
  const map: Record<string, boolean> = {};
  for (const row of rows) {
    map[row.flagKey] = row.value;
  }
  return map;
}

async function getGlobalMap(
  deps: FlagServiceDeps = {},
): Promise<Record<string, GlobalFlagSummary>> {
  const cache = getRedis(deps);
  try {
    const cached = await cache.get(GLOBAL_CACHE_KEY);
    if (cached) {
      return JSON.parse(cached) as Record<string, GlobalFlagSummary>;
    }
  } catch (err) {
    // Cache failure must NOT crash flag evaluation — fall through to
    // PG. A Redis outage already manifests as elevated p99; we don't
    // also want to flip every gated route to 404.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "flags: global cache read failed, falling back to PG",
    );
  }

  const map = await loadGlobalFromDb(getDb(deps));

  try {
    await cache.set(GLOBAL_CACHE_KEY, JSON.stringify(map), "EX", CACHE_TTL_SECONDS);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "flags: global cache write failed, evaluator will keep falling through to PG until Redis recovers",
    );
  }

  return map;
}

async function getTenantMap(
  deps: FlagServiceDeps,
  orgId: string,
): Promise<Record<string, boolean>> {
  const cache = getRedis(deps);
  const key = tenantCacheKey(orgId);
  try {
    const cached = await cache.get(key);
    if (cached) {
      return JSON.parse(cached) as Record<string, boolean>;
    }
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        orgId,
      },
      "flags: tenant cache read failed, falling back to PG",
    );
  }

  const map = await loadTenantFromDb(getDb(deps), orgId);

  try {
    await cache.set(key, JSON.stringify(map), "EX", CACHE_TTL_SECONDS);
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        orgId,
      },
      "flags: tenant cache write failed, evaluator will keep falling through to PG until Redis recovers",
    );
  }

  return map;
}

/** Optional evaluation context. `orgId` activates tenant overrides for `scope='tenant'` flags. */
export interface FlagContext {
  orgId?: string | null;
}

export interface FlagService {
  /**
   * Evaluate a single flag. Implements the doc 18 § 5 precedence:
   *   - Unknown key → false.
   *   - scope='platform' → platform default (tenant overrides ignored).
   *   - scope='tenant' + ctx.orgId → override if present, else default.
   *   - scope='tenant' + no ctx.orgId → platform default (worker path).
   */
  isEnabled(key: string, ctx?: FlagContext): Promise<boolean>;
  /** Bulk fetch for the super-admin Back Office list. */
  list(): Promise<FeatureFlagRow[]>;
  /**
   * Public projection — what tenant users see on `/v1/feature-flags`.
   * Filters by `public=true` AND evaluates the effective value for
   * the supplied org (override if present, else platform default).
   * Resolves the public-projection caveat from doc 18 § 0.
   */
  listPublic(ctx?: FlagContext): Promise<Array<{ key: string; enabled: boolean }>>;
  /** Override listing for the super-admin tenant detail page. */
  listOverridesForTenant(orgId: string): Promise<TenantFlagOverrideRow[]>;
  /**
   * Tenant listing for the super-admin per-flag management page.
   * LEFT-JOINs every active tenant against `tenant_flag_overrides`
   * for the supplied `flagKey`, so tenants without an override row
   * still appear (with `override: null` + `effectiveValue` = platform
   * default). Filters out non-active tenants (suspended / archived
   * shouldn't accumulate noise in the operator UI). Ordered by name.
   */
  listTenantsForFlag(flagKey: string): Promise<FlagTenantRow[]>;
  /** Override count per flag for the super-admin global view. */
  overrideStats(): Promise<Array<{ flagKey: string; enabledCount: number; disabledCount: number }>>;
  /** Invalidate the global flags cache. Called after a platform PATCH. */
  invalidate(): Promise<void>;
  /** Invalidate one tenant's override cache. Called after a PUT/DELETE override or PATCH /org/feature-flags. */
  invalidateTenant(orgId: string): Promise<void>;
}

/**
 * Build a `FlagService` bound to the supplied (or default) db + redis
 * handles. Each Fastify request decorates a fresh instance via the
 * plugin below so per-request mocking stays cheap.
 */
export function createFlagService(deps: FlagServiceDeps = {}): FlagService {
  return {
    async isEnabled(key, ctx) {
      const globalMap = await getGlobalMap(deps);
      const entry = globalMap[key];
      if (!entry) return false;

      // Platform-locked: tenant overrides ignored even if rows exist.
      if (entry.scope === "platform") return entry.enabled;

      // Tenant-scoped, no caller context: worker / platform path —
      // fall back to the platform default.
      const orgId = ctx?.orgId;
      if (!orgId) return entry.enabled;

      const tenantMap = await getTenantMap(deps, orgId);
      if (key in tenantMap) return tenantMap[key] === true;
      return entry.enabled;
    },

    async list() {
      const rows = await getDb(deps)
        .select({
          key: featureFlags.key,
          enabled: featureFlags.enabled,
          label: featureFlags.label,
          description: featureFlags.description,
          scope: featureFlags.scope,
          tenantOverrideAllowed: featureFlags.tenantOverrideAllowed,
          public: featureFlags.public,
          updatedBy: featureFlags.updatedBy,
          createdAt: featureFlags.createdAt,
          updatedAt: featureFlags.updatedAt,
        })
        .from(featureFlags)
        .orderBy(featureFlags.key);
      return rows.map((row) => ({
        key: row.key,
        enabled: row.enabled,
        label: row.label,
        description: row.description,
        scope: row.scope,
        tenantOverrideAllowed: row.tenantOverrideAllowed,
        public: row.public,
        updatedBy: row.updatedBy,
        createdAt:
          row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
        updatedAt:
          row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
      }));
    },

    async listPublic(ctx) {
      const globalMap = await getGlobalMap(deps);
      const orgId = ctx?.orgId ?? null;

      // Public-projection means: only rows where `public = true`.
      const publicKeys = await getDb(deps)
        .select({ key: featureFlags.key })
        .from(featureFlags)
        .where(eq(featureFlags.public, true));

      const tenantMap = orgId ? await getTenantMap(deps, orgId) : {};

      return publicKeys
        .map(({ key }) => {
          const entry = globalMap[key];
          if (!entry) return { key, enabled: false };
          if (entry.scope === "platform") return { key, enabled: entry.enabled };
          if (orgId && key in tenantMap) return { key, enabled: tenantMap[key] === true };
          return { key, enabled: entry.enabled };
        })
        .sort((a, b) => a.key.localeCompare(b.key));
    },

    async listTenantsForFlag(flagKey) {
      // LEFT JOIN every active tenant against this flag's overrides.
      // Drizzle's `leftJoin` on the override side leaves the row
      // columns nullable — we coalesce to `override: null` when the
      // join produced no match.
      const [flag] = await getDb(deps)
        .select({ enabled: featureFlags.enabled, scope: featureFlags.scope })
        .from(featureFlags)
        .where(eq(featureFlags.key, flagKey))
        .limit(1);
      if (!flag) return [];

      const rows = await getDb(deps)
        .select({
          tenantId: tenants.id,
          tenantName: tenants.name,
          tenantSlug: tenants.slug,
          overrideValue: tenantFlagOverrides.value,
          overrideReason: tenantFlagOverrides.reason,
          overrideSetBy: tenantFlagOverrides.setBy,
          overrideUpdatedAt: tenantFlagOverrides.updatedAt,
        })
        .from(tenants)
        .leftJoin(
          tenantFlagOverrides,
          and(
            eq(tenantFlagOverrides.tenantId, tenants.id),
            eq(tenantFlagOverrides.flagKey, flagKey),
          ),
        )
        .where(eq(tenants.status, "active"))
        .orderBy(tenants.name);

      return rows.map((row) => {
        const hasOverride = row.overrideValue !== null;
        // Platform-scoped flags ignore overrides at evaluation time;
        // we still surface the override row if one exists historically
        // so the operator can clean it up, but `effectiveValue` reflects
        // the evaluator's actual behaviour (= platform default).
        const effective =
          flag.scope === "tenant" && hasOverride ? (row.overrideValue as boolean) : flag.enabled;
        return {
          tenantId: row.tenantId,
          tenantName: row.tenantName,
          tenantSlug: row.tenantSlug,
          override: hasOverride
            ? {
                tenantId: row.tenantId,
                flagKey,
                value: row.overrideValue as boolean,
                reason: row.overrideReason,
                setBy: row.overrideSetBy,
                setAt:
                  row.overrideUpdatedAt instanceof Date
                    ? row.overrideUpdatedAt.toISOString()
                    : String(row.overrideUpdatedAt),
              }
            : null,
          effectiveValue: effective,
        };
      });
    },

    async listOverridesForTenant(orgId) {
      const rows = await getDb(deps)
        .select({
          flagKey: tenantFlagOverrides.flagKey,
          value: tenantFlagOverrides.value,
          reason: tenantFlagOverrides.reason,
          setBy: tenantFlagOverrides.setBy,
          updatedAt: tenantFlagOverrides.updatedAt,
        })
        .from(tenantFlagOverrides)
        .where(eq(tenantFlagOverrides.tenantId, orgId));
      return rows.map((row) => ({
        tenantId: orgId,
        flagKey: row.flagKey,
        value: row.value,
        reason: row.reason,
        setBy: row.setBy,
        setAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
      }));
    },

    async overrideStats() {
      // SQL `GROUP BY (flag_key, value)` — index-only scan against
      // the existing `tenant_flag_overrides_flag_idx`. Replaces a
      // prior in-memory aggregation that pulled every override row
      // into Node (data-architect review on PR #366). Returns at most
      // `2 × |tenant-scoped flags|` rows from the DB regardless of
      // tenant count.
      const grouped = await getDb(deps)
        .select({
          flagKey: tenantFlagOverrides.flagKey,
          value: tenantFlagOverrides.value,
          n: count(),
        })
        .from(tenantFlagOverrides)
        .groupBy(tenantFlagOverrides.flagKey, tenantFlagOverrides.value)
        .orderBy(sql`${tenantFlagOverrides.flagKey} ASC`);

      const acc = new Map<string, { enabledCount: number; disabledCount: number }>();
      for (const row of grouped) {
        const cur = acc.get(row.flagKey) ?? { enabledCount: 0, disabledCount: 0 };
        if (row.value) cur.enabledCount = Number(row.n);
        else cur.disabledCount = Number(row.n);
        acc.set(row.flagKey, cur);
      }
      return Array.from(acc.entries()).map(([flagKey, counts]) => ({ flagKey, ...counts }));
    },

    async invalidate() {
      try {
        await getRedis(deps).del(GLOBAL_CACHE_KEY);
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "flags: global cache invalidate failed, value will refresh within TTL",
        );
      }
    },

    async invalidateTenant(orgId) {
      try {
        await getRedis(deps).del(tenantCacheKey(orgId));
      } catch (err) {
        logger.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            orgId,
          },
          "flags: tenant cache invalidate failed, value will refresh within TTL",
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
