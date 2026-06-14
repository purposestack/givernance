// #436 — finance.survey_retention
/**
 * Weekly cron job — soft-deletes `survey_responses` older than 24 months.
 *
 * Why 24 months: matches the docs/31 retention policy. Survey responses
 * are aggregated into the dashboard's KPIs (PMF %, NPS, CSAT) at write
 * time; the raw response row is no longer needed for analysis after the
 * 24-month window and is a GDPR-relevant residual that we proactively
 * minimise.
 *
 * Soft-delete (per CLAUDE.md "Soft-delete is universal"): we never
 * `DELETE FROM survey_responses`. The DPO can purge the row later via
 * the GDPR erasure path if required; the retention sweep just ages
 * rows out of the active surface.
 *
 * Batched: LIMIT 1000 per inner loop, repeat until no rows match. Keeps
 * lock duration short on the table and lets a Postgres maintenance
 * window or a slow disk get a breath between batches.
 *
 * Silent-cron alert: writes a Redis key tracking the number of
 * consecutive sweep ticks where 0 rows were deleted. After 30
 * consecutive zero-streak weeks (≈7 months), logs a WARN line so the
 * observability stack can alert on it — catches the "cron broke and
 * we stopped retaining" failure mode that has no other tell.
 */

import { auditLogs, surveyResponses } from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { count, inArray, sql } from "drizzle-orm";
import Redis from "ioredis";
import { env } from "../env.js";
import { db } from "../lib/db.js";
import { jobLogger } from "../lib/logger.js";

const BATCH_SIZE = 1000;
const ZERO_STREAK_KEY = "survey-retention:zero-streak";
const ZERO_STREAK_ALERT_THRESHOLD = 30;
const RETENTION_MONTHS = 24;

/**
 * Test seam: production wires the worker's shared ioredis connection;
 * tests can pass a minimal stub so we don't need a Redis instance for
 * the unit-level path.
 */
export interface SurveyRetentionDeps {
  redis?: Pick<Redis, "incr" | "set" | "get">;
}

interface SweepResult {
  totalDeleted: number;
  batchCount: number;
  oldestSubmittedAt: Date | null;
  newestSubmittedAt: Date | null;
}

/**
 * Inner batched sweep — extracted out of `processSurveyRetention` so
 * the orchestrator stays under the cognitive-complexity threshold.
 * Returns aggregate statistics for the caller's silent-cron tracking
 * and final log line.
 */
async function runRetentionSweep(): Promise<SweepResult> {
  let totalDeleted = 0;
  let batchCount = 0;
  let oldestSubmittedAt: Date | null = null;
  let newestSubmittedAt: Date | null = null;

  // Safety bound: cap at 100 batches per run so a runaway query can't
  // hold the worker hostage; if 100k rows really need deletion in one
  // night, the next weekly tick continues the sweep.
  for (let i = 0; i < 100; i += 1) {
    const batch = await db.execute<{
      id: string;
      submitted_at: Date;
    }>(sql`
      UPDATE survey_responses
      SET deleted_at = NOW()
      WHERE id IN (
        SELECT id FROM survey_responses
        WHERE submitted_at < NOW() - INTERVAL '${sql.raw(String(RETENTION_MONTHS))} months'
          AND deleted_at IS NULL
        ORDER BY submitted_at ASC
        LIMIT ${BATCH_SIZE}
      )
      RETURNING id, submitted_at
    `);

    const rows = (batch as unknown as { rows: { id: string; submitted_at: Date }[] }).rows;
    if (rows.length === 0) break;

    totalDeleted += rows.length;
    batchCount += 1;

    const batchOldest = rows[0]?.submitted_at ?? null;
    const batchNewest = rows[rows.length - 1]?.submitted_at ?? null;
    if (batchOldest && (!oldestSubmittedAt || batchOldest < oldestSubmittedAt)) {
      oldestSubmittedAt = batchOldest;
    }
    if (batchNewest && (!newestSubmittedAt || batchNewest > newestSubmittedAt)) {
      newestSubmittedAt = batchNewest;
    }

    await emitRetentionAuditRows(
      rows.map((r) => r.id),
      {
        batchSize: rows.length,
        oldestSubmittedAt: batchOldest,
        newestSubmittedAt: batchNewest,
      },
    );

    if (rows.length < BATCH_SIZE) break;
  }

  return { totalDeleted, batchCount, oldestSubmittedAt, newestSubmittedAt };
}

/**
 * Silent-cron monitoring: tracks consecutive zero-deletion runs in
 * Redis. Extracted so the orchestrator stays under the
 * cognitive-complexity threshold. Errors are logged + swallowed —
 * Redis hiccups must not fail the sweep.
 */
async function updateZeroStreak(
  redis: Pick<Redis, "incr" | "set" | "get">,
  totalDeleted: number,
  log: ReturnType<typeof jobLogger>,
): Promise<void> {
  try {
    if (totalDeleted === 0) {
      const streak = await redis.incr(ZERO_STREAK_KEY);
      if (streak >= ZERO_STREAK_ALERT_THRESHOLD) {
        log.warn(
          { event: "survey-retention.silent_cron_warning", zeroStreak: streak },
          `survey-retention deleted 0 rows for ${streak} consecutive runs — cron may be silently broken`,
        );
      }
    } else {
      await redis.set(ZERO_STREAK_KEY, "0");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    log.warn({ err: message }, "survey-retention: redis zero-streak update failed");
  }
}

export async function processSurveyRetention(
  job: Job,
  deps: SurveyRetentionDeps = {},
): Promise<void> {
  const log = jobLogger({ jobId: job.id, tenantId: "system" });

  // CROSS-TENANT INTENTIONAL: retention sweep spans every tenant —
  // owner-pool UPDATE scoped by the age + soft-delete predicate.
  // No org_id in scope because the policy is platform-wide.
  const { totalDeleted, batchCount, oldestSubmittedAt, newestSubmittedAt } =
    await runRetentionSweep();

  // Silent-cron monitoring: track consecutive zero-streak runs in
  // Redis. Reset on any non-zero sweep.
  const redis = deps.redis ?? getDefaultRedis();
  if (redis) {
    await updateZeroStreak(redis, totalDeleted, log);
  }

  log.info(
    {
      totalDeleted,
      batches: batchCount,
      oldestSubmittedAt: oldestSubmittedAt?.toISOString(),
      newestSubmittedAt: newestSubmittedAt?.toISOString(),
    },
    "survey retention sweep complete",
  );
}

/**
 * Emit one `audit_logs` row per distinct tenant represented in the
 * just-deleted batch. Keeps the per-tenant audit trail intact without
 * fanning out to one row per response.
 */
async function emitRetentionAuditRows(
  responseIds: string[],
  meta: {
    batchSize: number;
    oldestSubmittedAt: Date | null;
    newestSubmittedAt: Date | null;
  },
): Promise<void> {
  if (responseIds.length === 0) return;

  // CROSS-TENANT INTENTIONAL: retention is platform-wide; the GROUP BY
  // splits the audit emit per-tenant so each audit_logs row carries
  // the correct `org_id`. The IDs come from RETURNING on the soft-
  // delete UPDATE (so they're trusted), but we use Drizzle's typed
  // `inArray` + `groupBy` rather than `sql.raw` string-concat — the
  // SQLi-shaped pattern is the wrong reflex even when the inputs are
  // safe.
  const grouped = await db
    .select({ orgId: surveyResponses.orgId, cnt: count() })
    .from(surveyResponses)
    .where(inArray(surveyResponses.id, responseIds))
    .groupBy(surveyResponses.orgId);

  for (const r of grouped) {
    await db.insert(auditLogs).values({
      orgId: r.orgId,
      userId: null,
      actorId: null,
      action: "WORKER:survey.retention.batch_soft_deleted",
      resourceType: "survey_response_retention",
      resourceId: null,
      oldValues: null,
      newValues: {
        batchSize: meta.batchSize,
        deletedForTenant: r.cnt,
        oldestSubmittedAt: meta.oldestSubmittedAt?.toISOString() ?? null,
        newestSubmittedAt: meta.newestSubmittedAt?.toISOString() ?? null,
        retentionMonths: RETENTION_MONTHS,
      },
    });
  }
}

// Lazy default redis singleton so we don't open a connection at module
// load time in environments that don't need it (tests). The worker
// proper passes the shared connection via the env-driven URL.
let _redis: Redis | null = null;
function getDefaultRedis(): Redis | null {
  if (_redis) return _redis;
  try {
    _redis = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
    });
    return _redis;
  } catch {
    return null;
  }
}

// Re-export the keys for tests that want to assert zero-streak state.
export const _testHooks = {
  ZERO_STREAK_KEY,
  ZERO_STREAK_ALERT_THRESHOLD,
  BATCH_SIZE,
  RETENTION_MONTHS,
};
