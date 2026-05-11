/**
 * Platform-admin routes for the global feature-flag registry
 * (issue #326 / PR #352 follow-up — Magino-on-comment).
 *
 * Scope is intentionally minimal:
 *   - `GET    /v1/admin/feature-flags` — list every flag for the
 *     Back Office page.
 *   - `PATCH  /v1/admin/feature-flags/:key` — flip `enabled`. No
 *     other field is mutable from the UI: description + key are
 *     code-owned (see `FEATURE_FLAG_REGISTRY`); the only operator
 *     decision is on/off.
 *
 * No POST / DELETE — flag rows are created by the seed migration
 * (`0047_feature_flags.sql`) and live for the life of the code
 * reference. Removing a flag means deleting the code AND the row in
 * a follow-up migration; the UI can't sneak this in.
 *
 * Guard: `requireSuperAdmin` → 404 to non-super-admins (same anti-
 * disclosure posture as the rest of `/v1/admin/*`).
 *
 * Audit: the existing `audit-plugin` already records every mutating
 * request to `audit_logs`. A PATCH against this route therefore lands
 * with `action = 'PATCH:/v1/admin/feature-flags/:key'` and
 * `resourceType = 'admin'` — no extra wiring needed. The structured
 * service log below adds the BEFORE/AFTER values so SIEM can answer
 * "who flipped what" without joining tables.
 */

import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { flagService } from "../../lib/flags/flag-service.js";
import { requireAuth, requireSuperAdmin } from "../../lib/guards.js";
import {
  DataArrayResponseNoPagination,
  DataResponse,
  ErrorResponses,
  problemDetail,
} from "../../lib/schemas.js";
import { setFeatureFlag } from "./feature-flags-service.js";

const FlagKeyParams = Type.Object({
  key: Type.String({ minLength: 1, maxLength: 100 }),
});

const FlagRowSchema = Type.Object({
  key: Type.String(),
  enabled: Type.Boolean(),
  description: Type.String(),
  updatedBy: Type.Union([Type.Null(), Type.String()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

const ToggleBody = Type.Object({
  enabled: Type.Boolean(),
});

/**
 * Tenant-readable projection — just `{ key, enabled }` so a non-admin
 * UI can hide gated surfaces without seeing super-admin metadata
 * (description, updated_by, timestamps). Same shape every authenticated
 * caller gets; not tenant-scoped because the registry is global in
 * the MVP.
 */
const PublicFlagRowSchema = Type.Object({
  key: Type.String(),
  enabled: Type.Boolean(),
});

export async function featureFlagsRoutes(app: FastifyInstance) {
  /**
   * Tenant-readable flag list. Drives the SSR-side check on tenant
   * pages that need to hide a button when a flag is off (e.g. the
   * bulk-email button on the constituents page — PR #352 / issue
   * #326). Only `requireAuth` because flag *visibility* (the fact
   * that "feature X exists and is off") is not sensitive — what's
   * gated by super-admin is *control* + *description*, both of which
   * stay on `/v1/admin/feature-flags`.
   */
  app.get(
    "/feature-flags",
    {
      preHandler: requireAuth,
      // Same polling-cadence cap as the per-id GET on bulk-email-jobs
      // — the constituents page fetches once per render, but a buggy
      // client could re-fetch in a loop.
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["Feature flags"],
        response: {
          200: DataArrayResponseNoPagination(PublicFlagRowSchema),
          ...ErrorResponses,
        },
      },
    },
    async () => {
      const rows = await flagService.list();
      return { data: rows.map((row) => ({ key: row.key, enabled: row.enabled })) };
    },
  );

  /**
   * List every flag in the registry. The Back Office page reads this
   * once on mount; no polling needed — flag flips are operator-driven
   * and infrequent.
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
    async () => {
      const rows = await flagService.list();
      return { data: rows };
    },
  );

  /**
   * Flip a flag's `enabled` value. Returns the updated row.
   *
   * `key` is path-bound + validated against the existing registry
   * (404 on unknown key). The flag's `description` + `key` are
   * code-owned and not mutable from this endpoint — keep this in
   * lockstep with `FEATURE_FLAG_REGISTRY`.
   */
  app.patch(
    "/admin/feature-flags/:key",
    {
      preHandler: requireSuperAdmin,
      // Rate limit a chatty admin UI / scripted toggle storm.
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

      // `updated_by` references `users(id)` and SET NULLs on purge.
      // Super-admins live in `platform_admins` (no `users` row), so
      // we leave this NULL and rely on `audit_logs` for the "who"
      // — actorId there carries the JWT subject.
      const result = await setFeatureFlag(key, enabled, null);
      if (!result) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Feature flag not found"));
      }

      // Invalidate the Redis cache so the new value is observed on
      // the next gated-route hit (rather than waiting for the 60-s
      // TTL to expire).
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

      return { data: result.row };
    },
  );
}
