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
import { Type } from "@sinclair/typebox";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { systemDb } from "../../../lib/db.js";
import { requireFlag } from "../../../lib/flags/flag-guard.js";
import { requireAuth, requireSuperAdmin } from "../../../lib/guards.js";
import { redis } from "../../../lib/redis.js";
import { fetchPlatformReportObject } from "../../../lib/s3.js";
import {
  ErrorResponses,
  isUuidV4,
  ProblemDetailSchema,
  problemDetail,
} from "../../../lib/schemas.js";
import { buildFinanceSummaryCsv, buildFinanceSummaryCsvFilename } from "./csv.js";
import {
  backfillLast12Months,
  findById,
  listRecent,
  MonthValidationError,
  previousMonth,
  RegenerateError,
  regenerateReport,
  requestMonthlyReport,
} from "./monthly-report.js";
import { PeriodValidationError, resolvePeriod } from "./period.js";
import {
  BackfillResponse,
  CacheFlushResponse,
  InvitationIdParams,
  LaunchBody,
  LaunchResponse,
  ListReportsResponse,
  MonthlyReportBody,
  MonthlyReportResponse,
  RegenerateResponse,
  ReportIdParams,
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

async function emitAuditExport(
  request: FastifyRequest,
  metadata: Record<string, unknown>,
): Promise<void> {
  const platformOrgId = await getPlatformOrgId();
  try {
    await systemDb.insert(auditLogs).values({
      orgId: platformOrgId,
      userId: request.auth?.userId ?? null,
      actorId: request.auth?.userId ?? null,
      action: "export",
      resourceType: "platform_finance_summary",
      resourceId: null,
      newValues: metadata,
      ipHash: hashIp(request.ip),
      userAgent: request.headers["user-agent"] ?? undefined,
    });
  } catch (err) {
    request.log.error(
      { err, audit: "INSERT_FAILED" },
      "CRITICAL: super-admin finance export audit insert failed — GDPR accountability gap",
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

  // ─── GET /v1/superadmin/finance/summary.csv (#442) ──────────────────────
  // CSV export of the same payload as /summary. Same preHandler chain and
  // same query validation; the cache is intentionally bypassed because
  // the operator reaches for the CSV exactly when they want the freshest
  // numbers (post-import / post-refund). Audit log carries
  // action='export', resource_type='platform_finance_summary'.
  app.get(
    "/superadmin/finance/summary.csv",
    {
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.ADMIN_FINANCE_DASHBOARD), requireSuperAdmin],
      schema: {
        tags: ["Superadmin", "Finance"],
        querystring: SummaryQuery,
        response: {
          200: Type.String(),
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

      const result = await buildFinanceSummary({
        period,
        filters: { currency: query.currency, tenantId: query.tenantId },
      });

      const csv = buildFinanceSummaryCsv(result);
      const filename = buildFinanceSummaryCsvFilename(query.period);

      await emitAuditExport(request, {
        format: "csv",
        period: query.period,
        filters: {
          currency: query.currency ?? null,
          tenantId: query.tenantId ?? null,
          from: query.from ?? null,
          to: query.to ?? null,
        },
        ipHash: hashIp(request.ip),
        correlationId: request.id,
      });

      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename="${filename}"`);
      reply.header("Cache-Control", "no-store");
      return reply.send(csv);
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

  // ─── POST /v1/superadmin/finance/reports/monthly (issue #443) ───────────
  app.post(
    "/superadmin/finance/reports/monthly",
    {
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.ADMIN_FINANCE_DASHBOARD), requireSuperAdmin],
      schema: {
        tags: ["Superadmin", "Finance"],
        body: MonthlyReportBody,
        response: {
          200: MonthlyReportResponse,
          202: MonthlyReportResponse,
          ...ErrorResponses,
          400: ProblemDetailSchema,
        },
      },
    },
    async (request, reply) => {
      const body = (request.body ?? {}) as { month?: string };
      const targetMonth = body.month ?? previousMonth();

      const platformAdminId = await resolvePlatformAdminId(request.auth?.userId ?? "");

      let result: Awaited<ReturnType<typeof requestMonthlyReport>>;
      try {
        result = await requestMonthlyReport({
          month: targetMonth,
          requestedByPlatformAdminId: platformAdminId,
          traceparent:
            typeof request.headers.traceparent === "string"
              ? request.headers.traceparent
              : undefined,
        });
      } catch (err) {
        if (err instanceof MonthValidationError) {
          return reply.status(400).send(problemDetail(400, "Bad Request", err.detail));
        }
        throw err;
      }

      // Emit audit log: GDPR Art. 5(2) accountability — every report
      // generation is traced to a super-admin, with replay flagged so
      // a forensic timeline can tell a fresh enqueue from an
      // idempotent same-month replay.
      const platformOrgId = await getPlatformOrgId();
      try {
        await systemDb.insert(auditLogs).values({
          orgId: platformOrgId,
          userId: request.auth?.userId ?? null,
          actorId: request.auth?.userId ?? null,
          action: "generate",
          resourceType: "platform_finance_report",
          resourceId: result.row.id,
          newValues: {
            month: result.row.month,
            replayed: result.replayed,
            jobId: `monthly-finance-report-${result.row.id}`,
          },
          ipHash: hashIp(request.ip),
          userAgent: request.headers["user-agent"] ?? undefined,
        });
      } catch (err) {
        request.log.error(
          { err, audit: "INSERT_FAILED" },
          "CRITICAL: monthly finance report audit insert failed — GDPR accountability gap",
        );
      }

      reply.status(result.replayed ? 200 : 202);
      return {
        data: {
          id: result.row.id,
          month: result.row.month,
          status: result.row.status,
          failureReason: result.row.failureReason,
          createdAt: result.row.createdAt,
          readyAt: result.row.readyAt,
          pdfUrl:
            result.row.status === "ready"
              ? `/v1/superadmin/finance/reports/${result.row.id}/pdf`
              : null,
        },
      };
    },
  );

  // ─── GET /v1/superadmin/finance/reports (list recent) ───────────────────
  // Returns the 12 most-recent reports (any status) so the dashboard can
  // render an "Archive" panel of downloadable monthly PDFs. Filter is
  // applied client-side; the route returns the full set.
  app.get(
    "/superadmin/finance/reports",
    {
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.ADMIN_FINANCE_DASHBOARD), requireSuperAdmin],
      schema: {
        tags: ["Superadmin", "Finance"],
        response: {
          200: ListReportsResponse,
          ...ErrorResponses,
        },
      },
    },
    async () => {
      const rows = await listRecent(24);
      return {
        data: rows.map((r) => ({
          id: r.id,
          month: r.month,
          status: r.status,
          failureReason: r.failureReason,
          createdAt: r.createdAt,
          readyAt: r.readyAt,
          pdfUrl: r.status === "ready" ? `/v1/superadmin/finance/reports/${r.id}/pdf` : null,
        })),
      };
    },
  );

  // ─── POST /v1/superadmin/finance/reports/:id/regenerate ─────────────────
  // Marks the source row as superseded (status='failed', reason
  // "Remplacé par régénération") and creates a fresh row for the same
  // month using the current SQL + PDF renderer. The old row stays in
  // the table for RGPD Art. 5.2 accountability — we never lose the
  // trail of "what numbers were generated when".
  //
  // Rate-limited at 5/min/IP. The audit row carries a pointer to the
  // superseded id in `new_values.supersedes`, plus the new report id
  // in `resource_id`, so a forensic timeline can walk back through
  // every regeneration chain.
  app.post(
    "/superadmin/finance/reports/:id/regenerate",
    {
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.ADMIN_FINANCE_DASHBOARD), requireSuperAdmin],
      schema: {
        tags: ["Superadmin", "Finance"],
        params: ReportIdParams,
        response: {
          200: RegenerateResponse,
          ...ErrorResponses,
          404: ProblemDetailSchema,
          409: ProblemDetailSchema,
        },
      },
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const platformAdminId = await resolvePlatformAdminId(request.auth?.userId ?? "");

      let result: Awaited<ReturnType<typeof regenerateReport>>;
      try {
        result = await regenerateReport({
          sourceId: id,
          requestedByPlatformAdminId: platformAdminId,
          traceparent:
            typeof request.headers.traceparent === "string"
              ? request.headers.traceparent
              : undefined,
        });
      } catch (err) {
        if (err instanceof RegenerateError) {
          return reply
            .status(err.statusCode)
            .send(
              problemDetail(
                err.statusCode,
                err.statusCode === 404 ? "Not Found" : "Conflict",
                err.detail,
              ),
            );
        }
        throw err;
      }

      const platformOrgId = await getPlatformOrgId();
      try {
        await systemDb.insert(auditLogs).values({
          orgId: platformOrgId,
          userId: request.auth?.userId ?? null,
          actorId: request.auth?.userId ?? null,
          action: "regenerate",
          resourceType: "platform_finance_report",
          resourceId: result.newRow.id,
          newValues: {
            month: result.newRow.month,
            supersedes: result.supersededRow.id,
          },
          ipHash: hashIp(request.ip),
          userAgent: request.headers["user-agent"] ?? undefined,
        });
      } catch (err) {
        request.log.error(
          { err, audit: "INSERT_FAILED" },
          "CRITICAL: monthly finance report regenerate audit insert failed",
        );
      }

      const toWire = (r: typeof result.newRow) => ({
        id: r.id,
        month: r.month,
        status: r.status,
        failureReason: r.failureReason,
        createdAt: r.createdAt,
        readyAt: r.readyAt,
        pdfUrl: r.status === "ready" ? `/v1/superadmin/finance/reports/${r.id}/pdf` : null,
      });

      return {
        data: {
          newReport: toWire(result.newRow),
          supersededReport: toWire(result.supersededRow),
        },
      };
    },
  );

  // ─── GET /v1/superadmin/finance/reports/:id (polling) ───────────────────
  app.get(
    "/superadmin/finance/reports/:id",
    {
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.ADMIN_FINANCE_DASHBOARD), requireSuperAdmin],
      schema: {
        tags: ["Superadmin", "Finance"],
        params: ReportIdParams,
        response: {
          200: MonthlyReportResponse,
          ...ErrorResponses,
          404: ProblemDetailSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const row = await findById(id);
      if (!row) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Report not found."));
      }
      return {
        data: {
          id: row.id,
          month: row.month,
          status: row.status,
          failureReason: row.failureReason,
          createdAt: row.createdAt,
          readyAt: row.readyAt,
          pdfUrl: row.status === "ready" ? `/v1/superadmin/finance/reports/${row.id}/pdf` : null,
        },
      };
    },
  );

  // ─── GET /v1/superadmin/finance/reports/:id/pdf (streamed PDF) ──────────
  //
  // Stream-through-API rather than presigned URL: same rationale as
  // `fetchReceiptObject` (issue #214) — keeps the donor-/operator-
  // visible URL on the app's own apex and avoids baking the MinIO
  // hostname into a SigV4 signature that's only resolvable inside the
  // Docker network on staging.
  app.get(
    "/superadmin/finance/reports/:id/pdf",
    {
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.ADMIN_FINANCE_DASHBOARD), requireSuperAdmin],
      schema: {
        tags: ["Superadmin", "Finance"],
        params: ReportIdParams,
        response: {
          ...ErrorResponses,
          404: ProblemDetailSchema,
          409: ProblemDetailSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const row = await findById(id);
      if (!row) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Report not found."));
      }
      if (row.status !== "ready" || !row.pdfS3Key) {
        return reply
          .status(409)
          .send(
            problemDetail(
              409,
              "Conflict",
              `Report is not ready (status='${row.status}'). Poll GET /v1/superadmin/finance/reports/${row.id} until status='ready'.`,
            ),
          );
      }

      // Audit the download — separate `download` action so the
      // forensic timeline tells a generate from a re-download.
      const platformOrgId = await getPlatformOrgId();
      try {
        await systemDb.insert(auditLogs).values({
          orgId: platformOrgId,
          userId: request.auth?.userId ?? null,
          actorId: request.auth?.userId ?? null,
          action: "download",
          resourceType: "platform_finance_report",
          resourceId: row.id,
          newValues: { month: row.month },
          ipHash: hashIp(request.ip),
          userAgent: request.headers["user-agent"] ?? undefined,
        });
      } catch (err) {
        request.log.error(
          { err, audit: "INSERT_FAILED" },
          "CRITICAL: monthly finance report download audit insert failed",
        );
      }

      const { body, contentLength } = await fetchPlatformReportObject(row.pdfS3Key);
      reply.header("content-type", "application/pdf");
      reply.header(
        "content-disposition",
        `attachment; filename="givernance-platform-finance-${row.month}.pdf"`,
      );
      if (contentLength !== undefined) {
        reply.header("content-length", contentLength);
      }
      return reply.send(body);
    },
  );

  // ─── POST /v1/superadmin/finance/reports/backfill (issue #443) ──────────
  // Idempotently requests reports for each of the last 12 fully-completed
  // calendar months. Same flow as the manual button — re-uses the
  // partial unique index for same-month dedup. Powers the "Backfill
  // missing reports" action on the dashboard and the auto-cron that
  // fires on day 1 of each month (it ALSO calls this codepath through
  // requestMonthlyReport for resilience to past missed crons).
  //
  // Rate-limited at 2/min/IP — 12 sequential snapshot builds is a real
  // load spike on the SQL pool and we never need to backfill that
  // often.
  app.post(
    "/superadmin/finance/reports/backfill",
    {
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.ADMIN_FINANCE_DASHBOARD), requireSuperAdmin],
      schema: {
        tags: ["Superadmin", "Finance"],
        response: {
          200: BackfillResponse,
          ...ErrorResponses,
        },
      },
      config: {
        rateLimit: {
          max: 2,
          timeWindow: "1 minute",
        },
      },
    },
    async (request) => {
      const platformAdminId = await resolvePlatformAdminId(request.auth?.userId ?? "");

      const result = await backfillLast12Months({
        requestedByPlatformAdminId: platformAdminId,
        traceparent:
          typeof request.headers.traceparent === "string" ? request.headers.traceparent : undefined,
      });

      // Project internal ReportRow → wire shape. `pdfS3Key` is an
      // implementation detail (the S3 key is never exposed
      // client-side; clients use the `pdfUrl` route instead).
      const toWire = (r: (typeof result.enqueued)[number] | (typeof result.skipped)[number]) => ({
        id: r.id,
        month: r.month,
        status: r.status,
        failureReason: r.failureReason,
        createdAt: r.createdAt,
        readyAt: r.readyAt,
        pdfUrl: r.status === "ready" ? `/v1/superadmin/finance/reports/${r.id}/pdf` : null,
      });

      // One audit row summarising the backfill — individual report
      // enqueues already emit their own audit rows via
      // requestMonthlyReport → POST handler? No, requestMonthlyReport
      // itself does NOT audit (the POST route does). For the
      // backfill path, emit a single summary audit to keep the
      // audit_logs cardinality bounded.
      const platformOrgId = await getPlatformOrgId();
      try {
        await systemDb.insert(auditLogs).values({
          orgId: platformOrgId,
          userId: request.auth?.userId ?? null,
          actorId: request.auth?.userId ?? null,
          action: "backfill",
          resourceType: "platform_finance_report",
          resourceId: null,
          newValues: {
            enqueued: result.enqueued.map((r) => ({ id: r.id, month: r.month })),
            skipped: result.skipped.map((r) => ({ id: r.id, month: r.month })),
          },
          ipHash: hashIp(request.ip),
          userAgent: request.headers["user-agent"] ?? undefined,
        });
      } catch (err) {
        request.log.error(
          { err, audit: "INSERT_FAILED" },
          "CRITICAL: monthly finance report backfill audit insert failed",
        );
      }

      return {
        data: {
          enqueued: result.enqueued.map(toWire),
          skipped: result.skipped.map(toWire),
        },
      };
    },
  );
}
