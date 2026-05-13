/**
 * Feature-flag routes (issue #326 / PR #352, expanded by Epic #365 PR #366).
 *
 * Surface map (every new Phase-2 route is gated by
 * `ADMIN_FEATURE_FLAGS_PHASE2` as the FIRST preHandler — before
 * role guards — so an off-state 404 leaks no role info per the
 * Feature-flag-first rule in CLAUDE.md):
 *
 *   GET    /v1/feature-flags                                — public projection (public=true only)
 *   GET    /v1/admin/feature-flags                          — super-admin list (+ overrideStats when phase2 on)
 *   PATCH  /v1/admin/feature-flags/:key                     — super-admin platform-default flip
 *   GET    /v1/admin/tenants/:tenantId/feature-flags        — super-admin tenant-detail tab
 *   PUT    /v1/admin/tenants/:tenantId/feature-flags/:key   — super-admin upsert override
 *   DELETE /v1/admin/tenants/:tenantId/feature-flags/:key   — super-admin remove override
 *   GET    /v1/org/feature-flags                            — org-admin self-service list
 *   PATCH  /v1/org/feature-flags/:key                       — org-admin self-service toggle
 *
 * Audit trail: the existing `audit-plugin` records every mutating
 * request (PATCH/PUT/DELETE) to `audit_logs` automatically — no
 * bespoke emit calls in the handlers below. The plugin captures
 * `actor_id`, `org_id`, `action`, `resource_type`, `resource_id`,
 * + impersonation context, satisfying doc 18 § 4.3.
 *
 * Cache invalidation: every override write calls
 * `flagService.invalidateTenant(tenantId)` after the DB commit so the
 * next read sees the new value rather than waiting on the 60-s TTL.
 * Platform-default flips still call `flagService.invalidate()`.
 */

import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import { tenants } from "@givernance/shared/schema";
import { Type } from "@sinclair/typebox";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../lib/db.js";
import { requireFlag } from "../../lib/flags/flag-guard.js";
import { flagService } from "../../lib/flags/flag-service.js";
import { requireAuth, requireOrgAdmin, requireSuperAdmin } from "../../lib/guards.js";
import {
  DataArrayResponseNoPagination,
  DataResponse,
  ErrorResponses,
  ProblemDetailSchema,
  problemDetail,
  UuidSchema,
} from "../../lib/schemas.js";
import {
  removeOverrideAsSuperAdmin,
  removeOwnOrgOverride,
  resolveOverrideTarget,
  setFeatureFlag,
  upsertOverrideAsSuperAdmin,
  upsertOwnOrgOverride,
} from "./feature-flags-service.js";

const FlagKeyParams = Type.Object({
  key: Type.String({ minLength: 1, maxLength: 100 }),
});

const TenantFlagKeyParams = Type.Object({
  tenantId: UuidSchema,
  key: Type.String({ minLength: 1, maxLength: 100 }),
});

const TenantParams = Type.Object({
  tenantId: UuidSchema,
});

const ScopeSchema = Type.Union([Type.Literal("platform"), Type.Literal("tenant")]);

const OverrideStatsSchema = Type.Object({
  enabledCount: Type.Integer({ minimum: 0 }),
  disabledCount: Type.Integer({ minimum: 0 }),
});

const FlagRowSchema = Type.Object({
  key: Type.String(),
  enabled: Type.Boolean(),
  label: Type.String(),
  description: Type.String(),
  scope: ScopeSchema,
  tenantOverrideAllowed: Type.Boolean(),
  public: Type.Boolean(),
  updatedBy: Type.Union([Type.Null(), Type.String()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  /**
   * Present only when the caller is super-admin AND the
   * `admin.feature_flags_phase2` flag is on. Null otherwise — the
   * field stays in the schema so the frontend doesn't have to branch
   * on undefined vs. missing.
   */
  overrideStats: Type.Union([Type.Null(), OverrideStatsSchema]),
});

const ToggleBody = Type.Object({
  enabled: Type.Boolean(),
});

const TenantOverrideUpsertBody = Type.Object({
  value: Type.Boolean(),
  reason: Type.Optional(Type.Union([Type.Null(), Type.String({ maxLength: 1000 })])),
});

const TenantOverrideRowSchema = Type.Object({
  tenantId: UuidSchema,
  flagKey: Type.String(),
  value: Type.Boolean(),
  reason: Type.Union([Type.Null(), Type.String()]),
  setBy: Type.Union([Type.Null(), UuidSchema]),
  setAt: Type.String(),
});

/**
 * Anti-disclosure pre-check for super-admin tenant-scoped writes:
 * resolve `:tenantId` against the `tenants` table BEFORE touching
 * `tenant_flag_overrides`. Without this guard a malformed-but-UUID-
 * shaped tenantId would FK-fail at INSERT and surface as an
 * unstructured 500; worse, the per-route structured log would emit
 * *before* the failure, creating a side channel that confirms
 * tenant existence to an attacker probing super-admin creds.
 * (Security review M1 on PR #366.)
 */
async function ensureTenantExists(tenantId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return Boolean(row);
}

const FlagTenantRowSchema = Type.Object({
  tenantId: UuidSchema,
  tenantName: Type.String(),
  tenantSlug: Type.String(),
  override: Type.Union([Type.Null(), TenantOverrideRowSchema]),
  effectiveValue: Type.Boolean(),
});

const TenantFlagViewRowSchema = Type.Object({
  /** Flag metadata (mirrors the platform list shape). */
  key: Type.String(),
  label: Type.String(),
  description: Type.String(),
  scope: ScopeSchema,
  tenantOverrideAllowed: Type.Boolean(),
  public: Type.Boolean(),
  /** Platform default. */
  platformDefault: Type.Boolean(),
  /** Effective value for this tenant (override if present, else default). */
  effectiveValue: Type.Boolean(),
  /** Override row when present, null when the tenant uses the default. */
  override: Type.Union([Type.Null(), TenantOverrideRowSchema]),
});

const PublicFlagRowSchema = Type.Object({
  key: Type.String(),
  enabled: Type.Boolean(),
});

/**
 * Resolve `overrideStats` for a given flag key against the current
 * Phase-2 self-flag state. Used by both `GET /admin/feature-flags`
 * (list) and `PATCH /admin/feature-flags/:key` (single-row update)
 * so the response shape stays identical across endpoints — without
 * this, the PATCH used to return `overrideStats: null` and the FE
 * would optimistically replace the row, losing the
 * "Manage per organisation" button until the page reloaded.
 *
 * Accepts a pre-fetched stats map when the caller already has one
 * (the list path queries `overrideStats()` once for all flags) to
 * avoid the N+1 DB hit per row.
 */
async function resolveOverrideStatsFor(
  flagKey: string,
  phase2On: boolean,
  statsByKey?: Map<string, { enabledCount: number; disabledCount: number }>,
): Promise<{ enabledCount: number; disabledCount: number } | null> {
  if (!phase2On) return null;
  if (statsByKey) {
    return statsByKey.get(flagKey) ?? { enabledCount: 0, disabledCount: 0 };
  }
  const allStats = await flagService.overrideStats();
  const found = allStats.find((s) => s.flagKey === flagKey);
  return found
    ? { enabledCount: found.enabledCount, disabledCount: found.disabledCount }
    : { enabledCount: 0, disabledCount: 0 };
}

export async function featureFlagsRoutes(app: FastifyInstance) {
  /**
   * Tenant-readable flag list. Drives the SSR-side check on tenant
   * pages that need to hide a button when a flag is off. Phase 2:
   * the projection is filtered by `public=true` so unreleased flag
   * names no longer leak via DevTools — resolves the
   * public-projection caveat from doc 18 § 0. The evaluator also
   * overlays this caller's tenant overrides (when applicable) on
   * the value, so an org-admin who flipped a `scope='tenant'` flag
   * on for their org sees `enabled: true` here.
   */
  app.get(
    "/feature-flags",
    {
      preHandler: requireAuth,
      // Same polling-cadence cap as the per-id GET on bulk-email-jobs.
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["Feature flags"],
        response: {
          200: DataArrayResponseNoPagination(PublicFlagRowSchema),
          ...ErrorResponses,
        },
      },
    },
    async (request) => {
      const rows = await flagService.listPublic({ orgId: request.auth?.orgId ?? null });
      return { data: rows };
    },
  );

  /**
   * Super-admin global list. Returns the full registry. When the
   * Phase-2 flag is on, every row carries `overrideStats` (count of
   * tenants overriding to true / false). When the Phase-2 flag is
   * off, `overrideStats` is `null` so the JSON shape stays stable.
   */
  app.get(
    "/admin/feature-flags",
    {
      preHandler: requireSuperAdmin,
      schema: {
        tags: ["Admin"],
        response: {
          200: DataArrayResponseNoPagination(FlagRowSchema),
          ...ErrorResponses,
        },
      },
    },
    async (request) => {
      const rows = await flagService.list();
      const phase2On = await flagService.isEnabled(FEATURE_FLAG_KEYS.ADMIN_FEATURE_FLAGS_PHASE2, {
        orgId: request.auth?.orgId ?? null,
      });
      const statsByKey = phase2On
        ? new Map(
            (await flagService.overrideStats()).map((s) => [
              s.flagKey,
              { enabledCount: s.enabledCount, disabledCount: s.disabledCount },
            ]),
          )
        : undefined;
      return {
        data: await Promise.all(
          rows.map(async (row) => ({
            ...row,
            overrideStats: await resolveOverrideStatsFor(row.key, phase2On, statsByKey),
          })),
        ),
      };
    },
  );

  /**
   * Flip a platform default. Same Phase-1 behaviour — code-owned
   * label / description / scope / tenant_override_allowed / public
   * fields are NOT mutable from this endpoint (only `enabled` is).
   */
  app.patch(
    "/admin/feature-flags/:key",
    {
      preHandler: requireSuperAdmin,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["Admin"],
        params: FlagKeyParams,
        body: ToggleBody,
        response: {
          200: DataResponse(FlagRowSchema),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const userId = request.auth?.userId;
      if (!userId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const { key } = request.params as { key: string };
      const { enabled } = request.body as { enabled: boolean };

      const result = await setFeatureFlag(key, enabled, null);
      if (!result) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Feature flag not found"));
      }

      await flagService.invalidate();

      request.log.info(
        {
          event: "feature_flag.toggled",
          flagKey: key,
          enabled,
          previousEnabled: result.previousEnabled,
          actorUserId: userId,
        },
        "Feature flag toggled",
      );

      // Same shape as `GET /admin/feature-flags` so the FE can
      // optimistically replace the row without losing the
      // override-stats badges + the Manage button.
      const phase2On = await flagService.isEnabled(FEATURE_FLAG_KEYS.ADMIN_FEATURE_FLAGS_PHASE2, {
        orgId: request.auth?.orgId ?? null,
      });
      const overrideStats = await resolveOverrideStatsFor(key, phase2On);
      return { data: { ...result.row, overrideStats } };
    },
  );

  // ─── Phase 2: super-admin tenant-overrides ────────────────────────────────

  /**
   * Per-flag tenant management — drives the new
   * `/admin/feature-flags/[key]` page. Returns every active tenant
   * with its current effective value + override row (if any) for the
   * requested flag. Lets the super-admin manage "5 enabled across 45
   * tenants" without navigating tenant-by-tenant. Added on PR #366
   * after reviewer feedback that the per-tenant flow was impractical
   * at any meaningful tenant count.
   *
   * Returns an empty data array (not 404) for an unknown flag key —
   * the route is for browsing, and the page renders an "unknown flag"
   * empty state more gracefully than a 404 redirect.
   */
  app.get(
    "/admin/feature-flags/:key/tenants",
    {
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.ADMIN_FEATURE_FLAGS_PHASE2), requireSuperAdmin],
      schema: {
        tags: ["Admin"],
        params: FlagKeyParams,
        response: {
          200: DataArrayResponseNoPagination(FlagTenantRowSchema),
          ...ErrorResponses,
        },
      },
    },
    async (request) => {
      const { key } = request.params as { key: string };
      const rows = await flagService.listTenantsForFlag(key);
      return { data: rows };
    },
  );

  /**
   * List every flag from the super-admin's perspective on a single
   * tenant. Returns flag metadata + the platform default + the
   * effective value for THIS tenant + the override row (if any).
   * Drives the "Feature flags" tab on `/admin/tenants/[id]`.
   *
   * Includes `scope='platform'` flags as read-only context (the UI
   * renders them but the toggle is disabled): super-admin sometimes
   * needs to see "what's the bulk-email posture across this tenant?"
   * even though they can't override it per-tenant.
   */
  app.get(
    "/admin/tenants/:tenantId/feature-flags",
    {
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.ADMIN_FEATURE_FLAGS_PHASE2), requireSuperAdmin],
      schema: {
        tags: ["Admin"],
        params: TenantParams,
        response: {
          200: DataArrayResponseNoPagination(TenantFlagViewRowSchema),
          ...ErrorResponses,
        },
      },
    },
    async (request) => {
      const { tenantId } = request.params as { tenantId: string };
      const [flagRows, overrideRows] = await Promise.all([
        flagService.list(),
        flagService.listOverridesForTenant(tenantId),
      ]);
      const overrideByKey = new Map(overrideRows.map((o) => [o.flagKey, o]));
      return {
        data: flagRows.map((flag) => {
          const override = overrideByKey.get(flag.key) ?? null;
          // For platform-scoped flags the override row is meaningless;
          // we still surface it as null so the UI doesn't see stale
          // data if a historical override existed before the scope
          // was tightened. Effective value uses the override only
          // for tenant-scoped flags.
          const effective = flag.scope === "tenant" && override ? override.value : flag.enabled;
          return {
            key: flag.key,
            label: flag.label,
            description: flag.description,
            scope: flag.scope,
            tenantOverrideAllowed: flag.tenantOverrideAllowed,
            public: flag.public,
            platformDefault: flag.enabled,
            effectiveValue: effective,
            override: flag.scope === "tenant" ? override : null,
          };
        }),
      };
    },
  );

  /**
   * Upsert a per-tenant override. PUT semantics — re-PUT with the
   * same payload returns 200 and refreshes `set_by` / `reason` /
   * `updated_at`. Idempotent.
   *
   * Returns 404 when the flag key doesn't exist (anti-disclosure),
   * 422 when the flag is platform-scoped (the operator picked the
   * wrong tool for the job — the registry edit is a code change).
   */
  app.put(
    "/admin/tenants/:tenantId/feature-flags/:key",
    {
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.ADMIN_FEATURE_FLAGS_PHASE2), requireSuperAdmin],
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["Admin"],
        params: TenantFlagKeyParams,
        body: TenantOverrideUpsertBody,
        response: {
          200: DataResponse(TenantOverrideRowSchema),
          // Explicit 422 in the contract — handler returns it on a
          // platform-scoped flag, but `ErrorResponses` (401/403/404)
          // doesn't include 422 so OpenAPI consumers wouldn't know to
          // handle it. (API review item 1 on PR #366.)
          422: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { tenantId, key } = request.params as { tenantId: string; key: string };
      const body = request.body as { value: boolean; reason?: string | null };

      // Anti-disclosure: 404 a non-existent tenant before touching
      // the override row (security review M1).
      if (!(await ensureTenantExists(tenantId))) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Tenant not found"));
      }

      const target = await resolveOverrideTarget(key, "super_admin");
      if (!target.writable) {
        if (target.rejection === "flag_not_found") {
          return reply.status(404).send(problemDetail(404, "Not Found", "Feature flag not found"));
        }
        return reply
          .status(422)
          .send(
            problemDetail(
              422,
              "Unprocessable Entity",
              "This flag is platform-scoped and cannot have per-tenant overrides — flip the platform default instead",
            ),
          );
      }

      const result = await upsertOverrideAsSuperAdmin({
        tenantId,
        flagKey: key,
        value: body.value,
        reason: body.reason ?? null,
        // `set_by` references `users(id)`; super-admins live in
        // `platform_admins` (no `users` row), so we leave this NULL
        // and rely on `audit_logs` for the "who". Org-admin path
        // populates this with their `users.id`.
        setBy: null,
      });
      if (!result) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Feature flag not found"));
      }

      await flagService.invalidateTenant(tenantId);

      request.log.info(
        {
          event: "tenant_flag_override.set",
          tenantId,
          flagKey: key,
          value: body.value,
          previousValue: result.previousValue,
          actorUserId: request.auth?.userId,
        },
        "Tenant flag override upserted",
      );

      return { data: result.row };
    },
  );

  /**
   * Remove a per-tenant override (revert to platform default).
   * 204 on success regardless of whether a row was actually
   * deleted — the caller's intent is "ensure no override exists",
   * which is the same outcome either way.
   */
  app.delete(
    "/admin/tenants/:tenantId/feature-flags/:key",
    {
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.ADMIN_FEATURE_FLAGS_PHASE2), requireSuperAdmin],
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["Admin"],
        params: TenantFlagKeyParams,
        response: {
          204: Type.Null(),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { tenantId, key } = request.params as { tenantId: string; key: string };

      // Anti-disclosure: 404 a non-existent tenant (security review M1).
      // Returning 204 silently for an unknown tenant would leak existence
      // via timing differences against a real-tenant DELETE.
      if (!(await ensureTenantExists(tenantId))) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Tenant not found"));
      }

      const result = await removeOverrideAsSuperAdmin(tenantId, key);
      await flagService.invalidateTenant(tenantId);
      request.log.info(
        {
          event: "tenant_flag_override.removed",
          tenantId,
          flagKey: key,
          previousValue: result?.previousValue ?? null,
          actorUserId: request.auth?.userId,
        },
        "Tenant flag override removed",
      );
      return reply.status(204).send();
    },
  );

  // ─── Phase 2: org-admin self-service ──────────────────────────────────────

  /**
   * Org-admin self-service list. Returns ONLY flags where
   * `scope='tenant' AND tenant_override_allowed=true`. Day-one,
   * the registry has zero such flags — the page renders an
   * explanatory empty state.
   *
   * `effectiveValue` is computed with the caller's org context so
   * a recently-flipped override is visible immediately.
   */
  app.get(
    "/org/feature-flags",
    {
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.ADMIN_FEATURE_FLAGS_PHASE2), requireOrgAdmin],
      schema: {
        tags: ["Org"],
        response: {
          200: DataArrayResponseNoPagination(TenantFlagViewRowSchema),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing org context"));
      }
      const [flagRows, overrideRows] = await Promise.all([
        flagService.list(),
        flagService.listOverridesForTenant(orgId),
      ]);
      const overrideByKey = new Map(overrideRows.map((o) => [o.flagKey, o]));
      return {
        data: flagRows
          .filter((flag) => flag.scope === "tenant" && flag.tenantOverrideAllowed)
          .map((flag) => {
            const override = overrideByKey.get(flag.key) ?? null;
            return {
              key: flag.key,
              label: flag.label,
              description: flag.description,
              scope: flag.scope,
              tenantOverrideAllowed: flag.tenantOverrideAllowed,
              public: flag.public,
              platformDefault: flag.enabled,
              effectiveValue: override ? override.value : flag.enabled,
              override,
            };
          }),
      };
    },
  );

  /**
   * Org-admin self-service toggle. Re-uses the override upsert
   * path with `org_admin` actor — `resolveOverrideTarget` enforces
   * `scope='tenant' AND tenant_override_allowed=true`, returning
   * 404 (anti-disclosure) when the org-admin tries to write a
   * flag that's platform-scoped or admin-gated.
   */
  app.patch(
    "/org/feature-flags/:key",
    {
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.ADMIN_FEATURE_FLAGS_PHASE2), requireOrgAdmin],
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["Org"],
        params: FlagKeyParams,
        body: TenantOverrideUpsertBody,
        response: {
          200: DataResponse(TenantOverrideRowSchema),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      const userId = request.auth?.userId;
      if (!orgId || !userId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const { key } = request.params as { key: string };
      const body = request.body as { value: boolean; reason?: string | null };

      const target = await resolveOverrideTarget(key, "org_admin");
      if (!target.writable) {
        // Org-admin path uses 404 for every rejection — same anti-
        // disclosure posture as `requireSuperAdmin` returning 404 to
        // non-super-admins.
        return reply.status(404).send(problemDetail(404, "Not Found", "Feature flag not found"));
      }

      const result = await upsertOwnOrgOverride({
        orgId,
        flagKey: key,
        value: body.value,
        reason: body.reason ?? null,
        setBy: userId,
      });
      if (!result) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Feature flag not found"));
      }

      await flagService.invalidateTenant(orgId);

      request.log.info(
        {
          event: "org_flag_override.set",
          tenantId: orgId,
          flagKey: key,
          value: body.value,
          previousValue: result.previousValue,
          actorUserId: userId,
        },
        "Org-admin flag override upserted",
      );

      return { data: result.row };
    },
  );

  /**
   * Org-admin "use the platform default" — DELETE the override row
   * for this org. Replaces the Phase-2 frontend's PATCH-as-delete
   * hack (FE review R3 + API review item 2 on PR #366). 204 on
   * success regardless of whether a row existed (idempotent intent
   * = "ensure no override exists for this org").
   *
   * Gate: `resolveOverrideTarget(..., 'org_admin')` enforces the
   * same `scope='tenant' AND tenant_override_allowed=true` check
   * the PATCH path uses, so an org-admin can't side-channel-probe
   * platform-scoped flag existence via DELETE either.
   */
  app.delete(
    "/org/feature-flags/:key",
    {
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.ADMIN_FEATURE_FLAGS_PHASE2), requireOrgAdmin],
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["Org"],
        params: FlagKeyParams,
        response: {
          204: Type.Null(),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      const userId = request.auth?.userId;
      if (!orgId || !userId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const { key } = request.params as { key: string };

      const target = await resolveOverrideTarget(key, "org_admin");
      if (!target.writable) {
        // Same anti-disclosure posture as the PATCH path — every
        // rejection (missing flag, platform-scoped, admin-gated)
        // looks like a typo'd URL.
        return reply.status(404).send(problemDetail(404, "Not Found", "Feature flag not found"));
      }

      const result = await removeOwnOrgOverride(orgId, key);
      await flagService.invalidateTenant(orgId);

      request.log.info(
        {
          event: "org_flag_override.removed",
          tenantId: orgId,
          flagKey: key,
          previousValue: result?.previousValue ?? null,
          actorUserId: userId,
        },
        "Org-admin flag override removed",
      );

      return reply.status(204).send();
    },
  );
}
