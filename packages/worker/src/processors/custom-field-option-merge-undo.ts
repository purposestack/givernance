/**
 * Picklist option-merge undo (Epic #539, docs/35).
 *
 * Input: one `custom_field.option_merge_undo_requested` outbox event
 * routed onto `CUSTOM_FIELDS_QUEUE` (concurrency 1, so an undo can never
 * interleave with the backfill of the same merge). The API route already
 * re-activated the source option inside the same transaction that
 * emitted the event; this job owns the value restore:
 *
 *   1. Re-checks the domain feature flag for the tenant.
 *   2. Restores `previous_value` from `custom_field_merge_undo` chunk by
 *      chunk — each chunk is one RLS-scoped transaction that takes the
 *      per-org custom-field VALUES advisory lock (serialising against
 *      GDPR erasure), DELETES up to CHUNK_SIZE undo rows first (consume-
 *      first, with RETURNING), then rewrites each returned entity's key
 *      via `jsonb_set`. A crashed/retried job resumes exactly where it
 *      left off and never double-restores, and an erasure purge racing
 *      the restore serialises on the undo-row delete — a purged row is
 *      never replayed onto the erased entity.
 *   3. Writes ONE `audit_logs` row with counts + ids only (anti-goal #7).
 */

import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import {
  CUSTOM_FIELD_DOMAIN_VALUES,
  type CustomFieldDomain,
  customFieldsCacheKey,
} from "@givernance/shared/custom-fields";
import type { CustomFieldOptionMergeUndoJob } from "@givernance/shared/jobs";
import { auditLogs, customFieldDefinitions } from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { and, eq, sql } from "drizzle-orm";
import { acquireCustomFieldValuesLock } from "../lib/custom-field-locks.js";
import { withWorkerContext } from "../lib/db.js";
import { isFlagEnabledForTenant } from "../lib/flags.js";
import { jobLogger } from "../lib/logger.js";
import { redis } from "../lib/redis.js";
import { extractTraceId } from "../lib/trace-context.js";

const CHUNK_SIZE = 500;
const MAX_CHUNKS = 20_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DOMAIN_FLAG_KEYS = {
  constituent: FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS,
  donation: FEATURE_FLAG_KEYS.DONATIONS_CUSTOM_FIELDS,
  campaign: FEATURE_FLAG_KEYS.CAMPAIGNS_CUSTOM_FIELDS,
} as const satisfies Record<CustomFieldDomain, string>;

/**
 * Same closed map as the merge processor — `sql.raw` is safe ONLY for
 * these values. `constituents` carries the soft-delete predicate:
 * soft-deleted rows include GDPR-erased ones (`custom = '{}'`), and an
 * undo must NEVER resurrect pre-erasure values onto them (`jsonb_set`
 * with `create_missing` would re-add the wiped key). Erasure also purges
 * the subject's undo rows; this predicate is defence in depth.
 */
const DOMAIN_TABLES: Record<CustomFieldDomain, { table: string; softDelete: boolean }> = {
  constituent: { table: "constituents", softDelete: true },
  donation: { table: "donations", softDelete: false },
  campaign: { table: "campaigns", softDelete: false },
};

type OptionMergeUndoResult =
  | { status: "completed"; restoredRows: number; chunks: number }
  | { status: "skipped"; reason: string };

async function invalidateCatalogCache(orgId: string): Promise<void> {
  const keys = CUSTOM_FIELD_DOMAIN_VALUES.map((domain) => customFieldsCacheKey(orgId, domain));
  try {
    await redis.unlink(...keys);
  } catch {
    // Best-effort — the API's 60 s TTL is the staleness backstop.
  }
}

interface UndoChunkParams {
  orgId: string;
  mergeId: string;
  key: string;
  domain: CustomFieldDomain;
}

interface UndoChunkOutcome {
  /** Undo rows consumed (deleted) — the loop's progress signal. */
  consumed: number;
  /** Entities whose value was actually restored (consumed minus erased/deleted skips). */
  restored: number;
}

/**
 * One chunk = one RLS transaction: CONSUME (delete, with RETURNING) up
 * to CHUNK_SIZE undo rows first, then restore each returned entity's
 * key. `consumed === 0` ⇒ done. Entities deleted (or, for constituents,
 * soft-deleted/erased) since the merge simply no-op the UPDATE — their
 * undo row was still consumed, so retries stay clean.
 *
 * Erasure-race hardening (PR #550 MAJOR-2): the chunk takes the per-org
 * custom-field VALUES advisory lock — the same lock the GDPR erasure
 * transaction holds — so a restore can never interleave with an erasure.
 * Consume-first is the second wall: the restore only ever replays undo
 * rows THIS transaction deleted, so an erasure purge racing the chunk
 * serialises on the undo-row lock — whichever deletes the row first
 * wins, and a purged row is never replayed onto the erased entity
 * (donations have no `deleted_at` guard, so ordering alone must hold).
 */
async function restoreChunk(params: UndoChunkParams): Promise<UndoChunkOutcome> {
  const { orgId, mergeId, key } = params;
  const { table, softDelete } = DOMAIN_TABLES[params.domain];

  return withWorkerContext(orgId, async (tx) => {
    await acquireCustomFieldValuesLock(tx, orgId);
    const consumed = await tx.execute(sql`
      DELETE FROM custom_field_merge_undo
      WHERE org_id = ${orgId}
        AND id IN (
          SELECT id FROM custom_field_merge_undo
          WHERE org_id = ${orgId} AND merge_id = ${mergeId}
          ORDER BY id
          LIMIT ${CHUNK_SIZE}
        )
      RETURNING id, entity_id, previous_value
    `);
    const rows = consumed.rows as Array<{ entity_id: string; previous_value: unknown }>;
    if (rows.length === 0) return { consumed: 0, restored: 0 };

    let restored = 0;
    for (const row of rows) {
      const previous = JSON.stringify(row.previous_value);
      const updated = await tx.execute(sql`
        UPDATE ${sql.raw(table)}
        SET custom = jsonb_set(custom, ARRAY[${key}::text], ${previous}::jsonb),
            updated_at = now()
        WHERE id = ${row.entity_id} AND org_id = ${orgId}
          ${softDelete ? sql`AND deleted_at IS NULL` : sql``}
        RETURNING id
      `);
      restored += updated.rows.length;
    }
    return { consumed: rows.length, restored };
  });
}

export async function processCustomFieldOptionMergeUndo(
  job: Job<CustomFieldOptionMergeUndoJob["data"]>,
): Promise<OptionMergeUndoResult> {
  const data = job.data;
  const log = jobLogger({
    tenantId: data.orgId,
    jobId: job.id,
    traceId: extractTraceId(data.traceparent),
  });

  const definition = await withWorkerContext(data.orgId, async (tx) => {
    const [row] = await tx
      .select({
        id: customFieldDefinitions.id,
        domain: customFieldDefinitions.domain,
        key: customFieldDefinitions.key,
        type: customFieldDefinitions.type,
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
    log.warn({ definitionId: data.definitionId }, "Merge undo: definition not found — dropping");
    return { status: "skipped", reason: "definition_not_found" };
  }

  const flagKey = DOMAIN_FLAG_KEYS[definition.domain];
  if (!(await isFlagEnabledForTenant(flagKey, data.orgId))) {
    log.warn(
      { definitionId: definition.id, flagKey },
      "Merge undo: domain feature flag is off — dropping job",
    );
    return { status: "skipped", reason: "flag_disabled" };
  }

  let restoredRows = 0;
  let chunks = 0;
  const chunkParams: UndoChunkParams = {
    orgId: data.orgId,
    mergeId: data.mergeId,
    key: definition.key,
    domain: definition.domain,
  };
  while (chunks < MAX_CHUNKS) {
    const outcome = await restoreChunk(chunkParams);
    if (outcome.consumed === 0) break;
    chunks += 1;
    restoredRows += outcome.restored;
    log.info({ mergeId: data.mergeId, chunk: chunks, ...outcome }, "Merge undo: chunk restored");
  }

  await invalidateCatalogCache(data.orgId);

  // Counts + ids only (anti-goal #7).
  await withWorkerContext(data.orgId, async (tx) => {
    await tx.insert(auditLogs).values({
      orgId: data.orgId,
      userId: data.requestedBy && UUID_RE.test(data.requestedBy) ? data.requestedBy : null,
      action: "custom_field.option_merge_undo_backfilled",
      resourceType: "custom_field_definitions",
      resourceId: data.definitionId,
      newValues: {
        mergeId: data.mergeId,
        domain: definition.domain,
        key: definition.key,
        sourceOptionId: data.sourceOptionId,
        targetOptionId: data.targetOptionId,
        restoredRows,
        chunks,
      },
    });
  });

  log.info(
    {
      mergeId: data.mergeId,
      restoredRows,
      chunks,
      event: "custom_field.option_merge_undo.completed",
    },
    "Option merge undo finalised",
  );
  return { status: "completed", restoredRows, chunks };
}
