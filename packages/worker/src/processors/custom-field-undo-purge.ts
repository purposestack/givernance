/**
 * Merge-undo retention purge (Epic #539, docs/35).
 *
 * Daily cron deleting `custom_field_merge_undo` rows past `expires_at`
 * (30-day undo window, `CUSTOM_FIELD_MERGE_UNDO_TTL_DAYS`). The table
 * is the ONLY place pre-merge values live — audit rows carry counts +
 * ids — so this sweep is what bounds the engine's shadow-copy of
 * operator data.
 *
 * NOT feature-flag-gated: retention hygiene must keep running even
 * after a tenant's custom-fields flags are switched off (same doctrine
 * as the erasure helpers — docs/35 §GDPR).
 */

import { customFieldMergeUndo } from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { lt } from "drizzle-orm";
import { db } from "../lib/db.js";
import { jobLogger } from "../lib/logger.js";

export async function processCustomFieldUndoPurge(job: Job): Promise<{ deleted: number }> {
  const log = jobLogger({ jobId: job.id });

  // Owner-pool cross-tenant delete: this is a platform-wide retention
  // sweep over every tenant's expired undo rows — the expiry predicate
  // is the scope, not a tenant id (issue #430 legitimate-cross-tenant
  // case, same posture as the survey retention sweep).
  const deleted = await db
    .delete(customFieldMergeUndo)
    .where(lt(customFieldMergeUndo.expiresAt, new Date()))
    .returning({ id: customFieldMergeUndo.id });

  log.info(
    { deleted: deleted.length, event: "custom_field.merge_undo_purged" },
    "Merge-undo purge completed",
  );
  return { deleted: deleted.length };
}
