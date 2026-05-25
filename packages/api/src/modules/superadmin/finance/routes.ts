// #437 — super-admin finance dashboard routes.
//
// Four endpoints:
//   GET  /v1/superadmin/finance/summary
//   POST /v1/superadmin/surveys/:slug/launch
//   POST /v1/superadmin/surveys/:slug/schedule
//   POST /v1/surveys/:invitationId/respond     (tenant user; NOT super-admin)
//
// Every super-admin route's preHandler chain is:
//   requireFlag(ADMIN_FINANCE_DASHBOARD) → requireSuperAdmin
// ORDER MATTERS: flag-first so a non-flagged probe gets 404 without
// revealing the role requirement.

import { createHash } from "node:crypto";
import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import { auditLogs, platformAdmins, tenants } from "@givernance/shared/schema";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { systemDb } from "../../../lib/db.js";
import { requireFlag } from "../../../lib/flags/flag-guard.js";
import { requireAuth, requireSuperAdmin } from "../../../lib/guards.js";
import { redis } from "../../../lib/redis.js";
import {
  ErrorResponses,
  isUuidV4,
  ProblemDetailSchema,
  problemDetail,
} from "../../../lib/schemas.js";
import { PeriodValidationError, resolvePeriod } from "./period.js";
import {
  CacheFlushResponse,
  InvitationIdParams,
  LaunchBody,
  LaunchResponse,
  RespondBody,
  RespondResponse,
  ScheduleBody,
  ScheduleResponse,
  SummaryQuery,
  SummaryResponse,
  SurveySlugParams,
} from "./schemas.js";
import { buildFinanceSummary } from "./service.js";
import { launchSurvey } from "./survey-launch.js";
import { submitSurveyResponse } from "./survey-respond.js";
import { type CadenceName, scheduleSurvey } from "./survey-schedule.js";

const PLATFORM_TENANT_SLUG = "__platform__";
const SUMMARY_CACHE_TTL_SECONDS = 300; // 5 minutes
const SUMMARY_CACHE_PREFIX = "superadmin:finance:summary:v1";

let cachedPlatformOrgId: string | null = null;

async function getPlatformOrgId(): Promise<string> {
  if (cachedPlatformOrgId) return cachedPlatformOrgId;
  const [row] = await systemDb
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, PLATFORM_TENANT_SLUG))
    .limit(1);
  if (!row) {
    throw new Error(
      "Platform sentinel tenant (slug='__platform__') is missing — see ADR-022 amendment.",
    );
  }
  cachedPlatformOrgId = row.id;
  return row.id;
}

/**
 * Resolve the `platform_admins.id` row of the super-admin behind a
 * given keycloak `sub`. Returns null when the super-admin presented a
 * valid JWT but has no `platform_admins` row — should only happen in
 * tests that mint a synthetic super-admin without seeding the row. We
 * still emit the audit then (with NULL `launched_by`-style fields)
 * because GDPR Art. 5(2) accountability is non-negotiable.
 */
async function resolvePlatformAdminId(keycloakSub: string): Promise<string | null> {
  const [row] = await systemDb
    .select({ id: platformAdmins.id })
    .from(platformAdmins)
    .where(and(eq(platformAdmins.keycloakId, keycloakSub), isNull(platformAdmins.deletedAt)))
    .limit(1);
  return row?.id ?? null;
}

function hashIp(ip: string): string {
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

function summaryCacheKey(input: {
  period: string;
  from?: string;
  to?: string;
  currency?: string;
  tenantId?: string;
}): string {
  return [
    SUMMARY_CACHE_PREFIX,
    input.period,
    input.from ?? "_",
    input.to ?? "_",
    input.currency ?? "all",
    input.tenantId ?? "all",
  ].join(":");
}

async function emitAuditView(
  request: FastifyRequest,
  metadata: Record<string, unknown>,
): Promise<void> {
  const platformOrgId = await getPlatformOrgId();
  try {
    await systemDb.insert(auditLogs).values({
      orgId: platformOrgId,
      userId: request.auth?.userId ?? null,
      actorId: request.auth?.userId ?? null,
      action: "view",
      resourceType: "platform_finance_summary",
      resourceId: null,
      newValues: metadata,
      ipHash: hashIp(request.ip),
      userAgent: request.headers["user-agent"] ?? undefined,
    });
  } catch (err) {
    request.log.error(
      { err, audit: "INSERT_FAILED" },
      "CRITICAL: super-admin finance view audit insert failed — GDPR accountability gap",
    );
  }
}

async function emitAuditCacheFlush(
  request: FastifyRequest,
  metadata: { pattern: string; keysDeleted: number },
): Promise<void> {
  const platformOrgId = await getPlatformOrgId();
  try {
    await systemDb.insert(auditLogs).values({
      orgId: platformOrgId,
      userId: request.auth?.userId ?? null,
      actorId: request.auth?.userId ?? null,
      action: "cache.flushed",
      resourceType: "platform_finance_summary",
      resourceId: null,
      newValues: metadata,
      ipHash: hashIp(request.ip),
      userAgent: request.headers["user-agent"] ?? undefined,
    });
  } catch (err) {
    request.log.error(
      { err, audit: "INSERT_FAILED", ...metadata },
      "CRITICAL: super-admin finance cache flush audit insert failed — GDPR accountability gap",
    );
  }
}

async function emitAuditSurveyLifecycle(
  request: FastifyRequest,
  resourceType: "survey_launch" | "survey_schedule",
  resourceId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const platformOrgId = await getPlatformOrgId();
  try {
    await systemDb.insert(auditLogs).values({
      orgId: platformOrgId,
      userId: request.auth?.userId ?? null,
      actorId: request.auth?.userId ?? null,
      action: resourceType === "survey_launch" ? "survey.launched" : "survey.scheduled",
      resourceType,
      resourceId,
      newValues: metadata,
      ipHash: hashIp(request.ip),
      userAgent: request.headers["user-agent"] ?? undefined,
    });
  } catch (err) {
    request.log.error(
      { err, audit: "INSERT_FAILED", resourceType, resourceId },
      "CRITICAL: super-admin survey lifecycle audit insert failed — GDPR accountability gap",
    );
  }
}

export async function superadminFinanceRoutes(app: FastifyInstance) {
  // ─── GET /v1/superadmin/finance/summary ─────────────────────────────────
  app.get(
    "/superadmin/finance/summary",
    {
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.ADMIN_FINANCE_DASHBOARD), requireSuperAdmin],
      schema: {
        tags: ["Superadmin", "Finance"],
        querystring: SummaryQuery,
        response: {
          200: SummaryResponse,
          ...ErrorResponses,
          400: ProblemDetailSchema,
        },
      },
    },
    async (request, reply) => {
      const query = request.query as {
        period: "today" | "7d" | "30d" | "90d" | "ytd" | "custom";
        from?: string;
        to?: string;
        currency?: "EUR" | "GBP" | "CHF" | "all";
        tenantId?: string;
      };

      let period: ReturnType<typeof resolvePeriod>;
      try {
        period = resolvePeriod(query.period, query.from, query.to);
      } catch (err) {
        if (err instanceof PeriodValidationError) {
          return reply.status(400).send(problemDetail(400, "Bad Request", err.detail));
        }
        throw err;
      }

      const cacheKey = summaryCacheKey({
        period: query.period,
        from: query.from,
        to: query.to,
        currency: query.currency,
        tenantId: query.tenantId,
      });

      const cached = await redis.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached) as { data: unknown };
        await emitAuditView(request, {
          period: query.period,
          filters: { currency: query.currency ?? null, tenantId: query.tenantId ?? null },
          ipHash: hashIp(request.ip),
          correlationId: request.id,
          cacheHit: true,
        });
        return parsed;
      }

      const result = await buildFinanceSummary({
        period,
        filters: { currency: query.currency, tenantId: query.tenantId },
      });

      const body = { data: result };
      // EX (seconds) + 5-min absolute TTL — no event-bound invalidation,
      // the dashboard's freshness pip is the user-facing cue.
      await redis.set(cacheKey, JSON.stringify(body), "EX", SUMMARY_CACHE_TTL_SECONDS);

      await emitAuditView(request, {
        period: query.period,
        filters: { currency: query.currency ?? null, tenantId: query.tenantId ?? null },
        ipHash: hashIp(request.ip),
        correlationId: request.id,
        cacheHit: false,
      });

      return body;
    },
  );

  // ─── POST /v1/superadmin/surveys/:slug/launch ───────────────────────────
  app.post(
    "/superadmin/surveys/:slug/launch",
    {
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.ADMIN_FINANCE_DASHBOARD), requireSuperAdmin],
      schema: {
        tags: ["Superadmin", "Surveys"],
        params: SurveySlugParams,
        body: LaunchBody,
        response: {
          202: LaunchResponse,
          ...ErrorResponses,
          400: ProblemDetailSchema,
          409: ProblemDetailSchema,
          429: ProblemDetailSchema,
        },
      },
    },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const body = request.body as { channel: "email" | "in_app" };
      const idempotencyKey = request.headers["idempotency-key"];

      if (!idempotencyKey || typeof idempotencyKey !== "string" || !isUuidV4(idempotencyKey)) {
        return reply
          .status(400)
          .send(
            problemDetail(
              400,
              "Bad Request",
              "Missing or malformed Idempotency-Key header (UUID v4 required).",
            ),
          );
      }

      const platformAdminId = await resolvePlatformAdminId(request.auth?.userId ?? "");
      if (!platformAdminId) {
        // The JWT validated as super_admin but the platform_admins row
        // is missing — surface 404 (consistent with other super-admin
        // anti-disclosure) instead of leaking the schema dependency.
        return reply.status(404).send(problemDetail(404, "Not Found", "Survey not found."));
      }

      const result = await launchSurvey({
        slug,
        channel: body.channel,
        idempotencyKey,
        launchedByPlatformAdminId: platformAdminId,
      });

      if ("kind" in result) {
        if (result.kind === "survey_not_found") {
          return reply.status(404).send(problemDetail(404, "Not Found", "Survey not found."));
        }
        if (result.kind === "idempotency_key_conflict") {
          return reply.status(409).send({
            type: "https://givernance.io/problems/idempotency-key-conflict",
            title: "Idempotency-Key reused with different request body",
            status: 409,
            detail:
              "An earlier request with this Idempotency-Key targeted a different (survey, channel) tuple. Generate a fresh UUID v4 for the new request.",
          });
        }
        if (result.kind === "rate_limited") {
          reply.header("Retry-After", String(result.retryAfterSeconds));
          return reply
            .status(429)
            .send(
              problemDetail(
                429,
                "Too Many Requests",
                `Cooldown active. Retry after ${result.retryAfterSeconds} seconds.`,
                { retry_after_seconds: result.retryAfterSeconds },
              ),
            );
        }
      }

      await emitAuditSurveyLifecycle(request, "survey_launch", result.launchId, {
        channel: body.channel,
        recipient_count: result.recipientCount,
        idempotency_key: idempotencyKey,
        replayed: result.replayed,
      });

      reply.status(202);
      return {
        data: {
          launchId: result.launchId,
          surveyId: result.surveyId,
          channel: result.channel,
          recipientCount: result.recipientCount,
          launchedAt: result.launchedAt.toISOString(),
        },
      };
    },
  );

  // ─── POST /v1/superadmin/surveys/:slug/schedule ─────────────────────────
  app.post(
    "/superadmin/surveys/:slug/schedule",
    {
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.ADMIN_FINANCE_DASHBOARD), requireSuperAdmin],
      schema: {
        tags: ["Superadmin", "Surveys"],
        params: SurveySlugParams,
        body: ScheduleBody,
        response: {
          200: ScheduleResponse,
          ...ErrorResponses,
          400: ProblemDetailSchema,
        },
      },
    },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const body = request.body as { cadence: CadenceName };

      const result = await scheduleSurvey({ slug, cadence: body.cadence });

      if ("kind" in result) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Survey not found."));
      }

      await emitAuditSurveyLifecycle(request, "survey_schedule", result.surveyId, {
        cadence: body.cadence,
        cadence_days: result.cadenceDays,
        no_op: result.noOp,
      });

      return {
        data: {
          surveyId: result.surveyId,
          cadence: result.cadence,
          cadenceDays: result.cadenceDays,
          nextScheduledAt: result.nextScheduledAt?.toISOString() ?? null,
        },
      };
    },
  );

  // ─── POST /v1/surveys/:invitationId/respond ─────────────────────────────
  app.post(
    "/surveys/:invitationId/respond",
    {
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.ADMIN_FINANCE_DASHBOARD), requireAuth],
      schema: {
        tags: ["Surveys"],
        params: InvitationIdParams,
        body: RespondBody,
        response: {
          200: RespondResponse,
          ...ErrorResponses,
          400: ProblemDetailSchema,
          409: ProblemDetailSchema,
        },
      },
    },
    async (request, reply) => {
      const { invitationId } = request.params as { invitationId: string };
      const body = request.body as {
        response: {
          score?: number;
          category?: string;
          rating?: number;
          text?: string;
          why_text?: string;
          comment?: string;
        };
      };

      const orgId = request.auth?.orgId;
      const userRowId = request.auth?.userRowId;
      if (!orgId || !userRowId) {
        // userRowId is null for super_admin (no tenant users row).
        // Super-admin doesn't have a tenant invitation either, so this
        // collapses to 404 (consistent anti-disclosure).
        return reply.status(404).send(problemDetail(404, "Not Found", "Invitation not found."));
      }

      const result = await submitSurveyResponse({
        invitationId,
        userId: userRowId,
        orgId,
        response: body.response,
      });

      if ("kind" in result) {
        if (result.kind === "invitation_not_found") {
          return reply.status(404).send(problemDetail(404, "Not Found", "Invitation not found."));
        }
        if (result.kind === "already_responded") {
          return reply
            .status(409)
            .send(problemDetail(409, "Conflict", "A response has already been submitted."));
        }
        if (result.kind === "invalid_text") {
          return reply
            .status(400)
            .send(
              problemDetail(
                400,
                "Bad Request",
                "Free-text fields must not contain `<` or `>` characters.",
              ),
            );
        }
      }

      // Defence in depth: never echo the response payload back. Audit
      // is handled by the auto-audit plugin (action='POST:/v1/surveys/
      // :invitationId/respond') — the audit row carries orgId, userId,
      // ipHash, userAgent automatically. We also have a structured
      // `survey_response` audit_logs row written by the auto-audit
      // plugin with resource_type='surveys' (top-level URL segment).
      return {
        data: {
          responseId: result.responseId,
          submittedAt: result.submittedAt.toISOString(),
        },
      };
    },
  );

  // ─── POST /v1/superadmin/finance/cache/flush (#449) ─────────────────
  // Invalidates the Redis cache for the platform finance summary so the
  // dashboard surfaces fresh data immediately after a manual SQL refresh
  // (e.g. SEED_DESTRUCTIVE_WIPE re-seed). Replaces the previous operator
  // workflow of SSH + redis-cli + URL-encoded AUTH gymnastics.
  //
  // Security posture (per issue #449 callout — "ne doit pas être une
  // faille"):
  //  - preHandler chain identical to other superadmin routes: requireFlag
  //    fires BEFORE requireSuperAdmin so a flag-off probe gets 404
  //    without revealing the route.
  //  - No request body / query / header. The Redis SCAN pattern is
  //    hardcoded server-side; a compromised super-admin can NOT extend
  //    the pattern to flush arbitrary keys (e.g. `*` to nuke the entire
  //    DB).
  //  - Rate-limited at 5 requests / minute / IP via @fastify/rate-limit.
  //    Defends against DoS via cache pounding (each flush forces the
  //    next request to re-run the expensive SQL aggregation; an
  //    attacker holding super-admin credentials could otherwise produce
  //    a cache-stampede load profile).
  //  - Idempotent: flushing twice is a safe no-op. No Idempotency-Key
  //    needed.
  //  - Audit log on every call (action='cache.flushed', resource_type=
  //    'platform_finance_summary'). GDPR Art. 5(2) accountability.
  //  - Response shape strict — only { keysDeleted, pattern }. No cache
  //    KEY listing exposed (keys carry tenantId + period filters which
  //    would leak usage patterns).
  app.post(
    "/superadmin/finance/cache/flush",
    {
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.ADMIN_FINANCE_DASHBOARD), requireSuperAdmin],
      schema: {
        tags: ["Superadmin", "Finance"],
        response: {
          200: CacheFlushResponse,
          ...ErrorResponses,
        },
      },
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "1 minute",
        },
      },
    },
    async (request) => {
      // Pattern is HARDCODED — no client-controlled SCAN scope.
      const pattern = `${SUMMARY_CACHE_PREFIX}:*`;
      const keys: string[] = [];
      let cursor = "0";
      do {
        const [nextCursor, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
        keys.push(...batch);
        cursor = nextCursor;
      } while (cursor !== "0");

      // UNLINK is the non-blocking sibling of DEL (Redis 4+). Safer for
      // a potentially large match set; falls back to no-op when keys is
      // empty.
      const keysDeleted = keys.length > 0 ? await redis.unlink(...keys) : 0;

      await emitAuditCacheFlush(request, { pattern, keysDeleted });

      return { data: { keysDeleted, pattern } };
    },
  );
}
