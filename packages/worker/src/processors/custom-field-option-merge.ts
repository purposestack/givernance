/**
 * Picklist option-merge backfill (Epic #539, docs/35).
 *
 * Input: one `custom_field.option_merge_requested` outbox event routed
 * onto `CUSTOM_FIELDS_QUEUE`. The worker:
 *   1. Re-checks the domain feature flag for the tenant (defence in
 *      depth — a flag flip can race an already-enqueued relay tick).
 *   2. Loads the definition and idempotently marks the source option
 *      `{ active: false, mergedInto: target }` BEFORE any rewrite, so
 *      new API writes reject the merged id while the backfill runs.
 *   3. Rewrites stored values chunk by chunk: each chunk is one
 *      RLS-scoped transaction that inserts the `custom_field_merge_undo`
 *      rows (pre-merge value of the touched key only) and applies the
 *      `jsonb_set` rewrite atomically. Rewritten rows stop matching the
 *      `@>` containment predicate, so a crashed/retried job resumes
 *      exactly where it left off and never duplicates undo rows.
 *   4. Writes ONE `audit_logs` row with counts + ids only — per-row
 *      pre-merge snapshots never enter long-retention audit storage
 *      (Epic #539 anti-goal #7; undo lives in the TTL'd table).
 *
 * The definition mutation invalidates the API's Redis catalog cache
 * directly (same Redis instance) so forms stop offering the merged
 * option within the request that follows, not a TTL window later.
 */

import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import {
  CUSTOM_FIELD_DOMAIN_VALUES,
  CUSTOM_FIELD_MERGE_UNDO_TTL_DAYS,
  type CustomFieldDomain,
  type CustomFieldOption,
  customFieldsCacheKey,
} from "@givernance/shared/custom-fields";
import type { CustomFieldOptionMergeJob } from "@givernance/shared/jobs";
import { auditLogs, customFieldDefinitions, customFieldMergeUndo } from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { and, eq, sql } from "drizzle-orm";
import { withWorkerContext } from "../lib/db.js";
import { isFlagEnabledForTenant } from "../lib/flags.js";
import { jobLogger } from "../lib/logger.js";
import { redis } from "../lib/redis.js";
import { extractTraceId } from "../lib/trace-context.js";

const CHUNK_SIZE = 500;
/** Hard ceiling — 500 × 20 000 = 10M rows, far beyond any tenant table. */
const MAX_CHUNKS = 20_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DOMAIN_FLAG_KEYS = {
  constituent: FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS,
  donation: FEATURE_FLAG_KEYS.DONATIONS_CUSTOM_FIELDS,
  campaign: FEATURE_FLAG_KEYS.CAMPAIGNS_CUSTOM_FIELDS,
} as const satisfies Record<CustomFieldDomain, string>;

/**
 * Closed table map — the raw-SQL fragments below interpolate these via
 * `sql.raw`, which is safe ONLY because the values come from this map
 * (never from job payload). `constituents` carries the soft-delete
 * predicate so the chunk scan rides the partial GIN index (0088);
 * soft-deleted rows keep their pre-merge value, which still renders via
 * the merged option's retained label.
 */
const DOMAIN_TABLES: Record<CustomFieldDomain, { table: string; softDelete: boolean }> = {
  constituent: { table: "constituents", softDelete: true },
  donation: { table: "donations", softDelete: false },
  campaign: { table: "campaigns", softDelete: false },
};

interface MergeCounters {
  rewrittenRows: number;
  chunks: number;
}

type OptionMergeResult =
  | { status: "completed"; rewrittenRows: number; chunks: number }
  | { status: "skipped"; reason: string };

async function invalidateCatalogCache(orgId: string): Promise<void> {
  const keys = CUSTOM_FIELD_DOMAIN_VALUES.map((domain) => customFieldsCacheKey(orgId, domain));
  try {
    await redis.unlink(...keys);
  } catch {
    // Best-effort — the API's 60 s TTL is the staleness backstop.
  }
}

/**
 * Compute the post-merge value of the touched key. Scalar picklists
 * become the target id; multi-picklists replace source with target and
 * dedupe (the row may already carry both).
 */
function rewriteValue(previous: unknown, sourceOptionId: string, targetOptionId: string): unknown {
  if (Array.isArray(previous)) {
    const next: unknown[] = [];
    for (const entry of previous) {
      const mapped = entry === sourceOptionId ? targetOptionId : entry;
      if (!next.includes(mapped)) next.push(mapped);
    }
    return next;
  }
  return targetOptionId;
}

interface ChunkParams {
  orgId: string;
  mergeId: string;
  definitionId: string;
  key: string;
  domain: CustomFieldDomain;
  sourceOptionId: string;
  targetOptionId: string;
  isMulti: boolean;
}

/**
 * One chunk = one RLS transaction: scan up to CHUNK_SIZE matching rows,
 * write their undo rows, rewrite them. Returns the number of rows
 * rewritten (0 ⇒ the backfill is complete).
 */
async function rewriteChunk(params: ChunkParams): Promise<number> {
  const { orgId, key, sourceOptionId, targetOptionId } = params;
  const { table, softDelete } = DOMAIN_TABLES[params.domain];
  const containment = JSON.stringify({
    [key]: params.isMulti ? [sourceOptionId] : sourceOptionId,
  });
  const expiresAt = new Date(Date.now() + CUSTOM_FIELD_MERGE_UNDO_TTL_DAYS * 24 * 60 * 60 * 1000);

  return withWorkerContext(orgId, async (tx) => {
    const scanned = await tx.execute(sql`
      SELECT id, custom -> ${key}::text AS value
      FROM ${sql.raw(table)}
      WHERE org_id = ${orgId}
        AND custom @> ${containment}::jsonb
        ${softDelete ? sql`AND deleted_at IS NULL` : sql``}
      ORDER BY id
      LIMIT ${CHUNK_SIZE}
    `);
    const rows = scanned.rows as Array<{ id: string; value: unknown }>;
    if (rows.length === 0) return 0;

    for (const row of rows) {
      await tx.insert(customFieldMergeUndo).values({
        orgId,
        definitionId: params.definitionId,
        mergeId: params.mergeId,
        sourceOptionId,
        targetOptionId,
        entityId: row.id,
        previousValue: row.value,
        expiresAt,
      });

      const nextValue = JSON.stringify(rewriteValue(row.value, sourceOptionId, targetOptionId));
      await tx.execute(sql`
        UPDATE ${sql.raw(table)}
        SET custom = jsonb_set(custom, ARRAY[${key}::text], ${nextValue}::jsonb),
            updated_at = now()
        WHERE id = ${row.id} AND org_id = ${orgId}
      `);
    }
    return rows.length;
  });
}

export async function processCustomFieldOptionMerge(
  job: Job<CustomFieldOptionMergeJob["data"]>,
): Promise<OptionMergeResult> {
  const data = job.data;
  const log = jobLogger({
    tenantId: data.orgId,
    jobId: job.id,
    traceId: extractTraceId(data.traceparent),
  });

  // 1. Load the definition (explicit eq(orgId) even on PK lookup — issue #430).
  const definition = await withWorkerContext(data.orgId, async (tx) => {
    const [row] = await tx
      .select({
        id: customFieldDefinitions.id,
        domain: customFieldDefinitions.domain,
        key: customFieldDefinitions.key,
        type: customFieldDefinitions.type,
        options: customFieldDefinitions.options,
      })
      .from(customFieldDefinitions)
      .where(
        and(
          eq(customFieldDefinitions.id, data.definitionId),
          eq(customFieldDefinitions.orgId, data.orgId),
        ),
      );
    return row ?? null;
  });

  if (!definition) {
    log.warn({ definitionId: data.definitionId }, "Option merge: definition not found — dropping");
    return { status: "skipped", reason: "definition_not_found" };
  }
  if (definition.type !== "picklist" && definition.type !== "multi_picklist") {
    log.warn({ definitionId: definition.id }, "Option merge: definition is not a picklist");
    return { status: "skipped", reason: "not_a_picklist" };
  }

  // 2. Flag gate for the definition's domain (defence in depth).
  const flagKey = DOMAIN_FLAG_KEYS[definition.domain];
  if (!(await isFlagEnabledForTenant(flagKey, data.orgId))) {
    log.warn(
      { definitionId: definition.id, flagKey },
      "Option merge: domain feature flag is off — dropping job",
    );
    return { status: "skipped", reason: "flag_disabled" };
  }

  const options = definition.options as CustomFieldOption[];
  const source = options.find((option) => option.id === data.sourceOptionId);
  const target = options.find((option) => option.id === data.targetOptionId);
  if (!source || !target) {
    log.warn(
      { definitionId: definition.id, source: Boolean(source), target: Boolean(target) },
      "Option merge: source or target option missing from definition — dropping",
    );
    return { status: "skipped", reason: "option_not_found" };
  }

  // 3. Idempotently mark the source option merged BEFORE rewriting, so
  //    concurrent API writes reject the merged id (inactive_option) while
  //    chunks are in flight.
  if (source.active || source.mergedInto !== data.targetOptionId) {
    const nextOptions = options.map((option) =>
      option.id === data.sourceOptionId
        ? { ...option, active: false, mergedInto: data.targetOptionId }
        : option,
    );
    await withWorkerContext(data.orgId, async (tx) => {
      await tx
        .update(customFieldDefinitions)
        .set({ options: nextOptions, updatedAt: new Date() })
        .where(
          and(
            eq(customFieldDefinitions.id, data.definitionId),
            eq(customFieldDefinitions.orgId, data.orgId),
          ),
        );
    });
    await invalidateCatalogCache(data.orgId);
  }

  // 4. Chunked rewrite.
  const counters: MergeCounters = { rewrittenRows: 0, chunks: 0 };
  const chunkParams: ChunkParams = {
    orgId: data.orgId,
    mergeId: data.mergeId,
    definitionId: data.definitionId,
    key: definition.key,
    domain: definition.domain,
    sourceOptionId: data.sourceOptionId,
    targetOptionId: data.targetOptionId,
    isMulti: definition.type === "multi_picklist",
  };
  while (counters.chunks < MAX_CHUNKS) {
    const rewritten = await rewriteChunk(chunkParams);
    if (rewritten === 0) break;
    counters.chunks += 1;
    counters.rewrittenRows += rewritten;
    log.info(
      { mergeId: data.mergeId, chunk: counters.chunks, rewritten },
      "Option merge: chunk rewritten",
    );
  }

  // 5. Finalise — counts + ids only (anti-goal #7).
  await withWorkerContext(data.orgId, async (tx) => {
    await tx.insert(auditLogs).values({
      orgId: data.orgId,
      // No request-scoped user in the worker; the outbox payload carries
      // the requesting admin's Keycloak sub. Guarded — a malformed value
      // must not fail the audit write.
      userId: data.requestedBy && UUID_RE.test(data.requestedBy) ? data.requestedBy : null,
      action: "custom_field.option_merge_backfilled",
      resourceType: "custom_field_definitions",
      resourceId: data.definitionId,
      newValues: {
        mergeId: data.mergeId,
        domain: definition.domain,
        key: definition.key,
        sourceOptionId: data.sourceOptionId,
        targetOptionId: data.targetOptionId,
        rewrittenRows: counters.rewrittenRows,
        chunks: counters.chunks,
      },
    });
  });

  log.info(
    { mergeId: data.mergeId, ...counters, event: "custom_field.option_merge.completed" },
    "Option merge backfill finalised",
  );
  return { status: "completed", ...counters };
}
