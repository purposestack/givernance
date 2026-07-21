/** Job processor — GDPR right-to-erasure (Art. 17) */

import type { GdprErasureJob } from "@givernance/shared/jobs";
import {
  auditLogs,
  constituents,
  customFieldDefinitions,
  customFieldMergeUndo,
  donations,
  mergeHistory,
} from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { acquireCustomFieldValuesLock } from "../lib/custom-field-locks.js";
import { withWorkerContext } from "../lib/db.js";
import { jobLogger } from "../lib/logger.js";

/**
 * Direct identifiers + the custom blob inside a `merge_history` snapshot
 * (snapshots are full Drizzle constituent rows, camelCase keys). Nulled
 * on erasure; ids, counters, and timestamps are preserved for Art. 5(2)
 * accountability.
 */
const SNAPSHOT_PII_FIELDS = [
  "firstName",
  "lastName",
  "email",
  "phone",
  "addressLine1",
  "addressLine2",
  "postalCode",
  "city",
  "countryCode",
  "tags",
  "custom",
] as const;

function redactSnapshot(snapshot: unknown): unknown {
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return snapshot;
  }
  const redacted: Record<string, unknown> = { ...(snapshot as Record<string, unknown>) };
  for (const field of SNAPSHOT_PII_FIELDS) {
    if (field in redacted) {
      redacted[field] = null;
    }
  }
  return redacted;
}

/**
 * Anonymize a constituent's PII per GDPR erasure request.
 *
 * One transaction, five steps (Epic #539 / docs/35 §6):
 *   1. Replace the constituent's direct identifiers with placeholders and
 *      wipe the custom-field blob (`custom = '{}'`) in the SAME update —
 *      operator-defined values are unclassifiable PII, so the whole blob
 *      goes with the identifiers.
 *   2. Strip donation-domain custom values whose definition is
 *      `sensitive = true` (Art. 9) from the donor's donations — even
 *      under the Swiss CO legal hold that retains the financial rows.
 *      Non-sensitive donation values stay with the row. Archived
 *      sensitive definitions are included: archiving retains values, so
 *      erasure must still reach them.
 *   3. Purge the subject's `custom_field_merge_undo` rows — the
 *      option-merge undo store holds pre-merge VALUES for up to 30 days,
 *      and an admin undo after erasure would otherwise resurrect them
 *      onto the wiped blob (constituent domain) or re-add stripped
 *      Art. 9 keys onto the donor's donations (sensitive donation
 *      definitions). The undo processor's `deleted_at IS NULL` guard is
 *      the second wall for the constituent side.
 *   4. Redact the erased party inside `merge_history` snapshots where
 *      they appear (survivor or merged side): identifiers + custom blobs
 *      are nulled, ids and counters stay, so the Art. 5(2) audit
 *      skeleton survives without indefinite PII retention (Art. 17).
 *   5. One counts-only audit row (never the erased values themselves).
 *
 * Erasure ALWAYS runs regardless of feature-flag state — no
 * `isFlagEnabled` gate, ever. Idempotent: a re-delivered job re-writes
 * the same placeholders and strips nothing new.
 */
export async function processGdprErasure(job: Job<GdprErasureJob["data"]>) {
  const { orgId, constituentId, requestedBy, requestedAt } = job.data;
  const log = jobLogger({ tenantId: orgId, jobId: job.id });

  return withWorkerContext(orgId, async (tx) => {
    // Serialise against the option-merge backfill / merge-undo restore
    // chunk transactions (same lock, taken first in each): without it, a
    // chunk that scanned rows or undo rows before this transaction
    // commits could re-add pre-erasure values onto the wiped blob /
    // stripped donations, or insert undo rows AFTER the purge below —
    // silently reversing the Art. 17 guarantee for up to 30 days.
    await acquireCustomFieldValuesLock(tx, orgId);

    const [existing] = await tx
      .select({ id: constituents.id, deletedAt: constituents.deletedAt })
      .from(constituents)
      .where(and(eq(constituents.id, constituentId), eq(constituents.orgId, orgId)));

    if (!existing) {
      log.warn({ constituentId }, "gdpr erasure: constituent not found — nothing to erase");
      return { status: "not_found", constituentId };
    }

    const now = new Date();

    await tx
      .update(constituents)
      .set({
        firstName: "Erased",
        lastName: "Erased",
        email: null,
        phone: null,
        addressLine1: null,
        addressLine2: null,
        postalCode: null,
        city: null,
        countryCode: null,
        tags: [],
        custom: {},
        deletedAt: existing.deletedAt ?? now,
        updatedAt: now,
      })
      .where(and(eq(constituents.id, constituentId), eq(constituents.orgId, orgId)));

    const sensitiveDefs = await tx
      .select({ key: customFieldDefinitions.key })
      .from(customFieldDefinitions)
      .where(
        and(
          eq(customFieldDefinitions.orgId, orgId),
          eq(customFieldDefinitions.domain, "donation"),
          eq(customFieldDefinitions.sensitive, true),
        ),
      );

    const sensitiveKeys = sensitiveDefs.map((def) => def.key);
    let donationsStripped = 0;
    if (sensitiveKeys.length > 0) {
      // `custom - text[]` drops the keys; the `?|` predicate keeps the
      // update idempotent and avoids rewriting untouched rows.
      // `sql.param` binds the whole array as ONE text[] parameter —
      // bare interpolation would expand it into a `(…, …)` record.
      const stripped = await tx
        .update(donations)
        .set({
          custom: sql`${donations.custom} - ${sql.param(sensitiveKeys)}::text[]`,
          updatedAt: now,
        })
        .where(
          and(
            eq(donations.constituentId, constituentId),
            eq(donations.orgId, orgId),
            sql`${donations.custom} ?| ${sql.param(sensitiveKeys)}::text[]`,
          ),
        )
        .returning({ id: donations.id });
      donationsStripped = stripped.length;
    }

    // 3. Purge the subject's option-merge undo rows so a post-erasure
    //    merge undo can never restore pre-erasure values (the undo
    //    processor replays them via jsonb_set with create_missing).
    //    Constituent-domain rows for the erased entity go entirely — the
    //    whole blob was wiped. Explicit eq(orgId) on every predicate
    //    (issue #430); RLS is the second wall.
    const purgedConstituentUndo = await tx
      .delete(customFieldMergeUndo)
      .where(
        and(
          eq(customFieldMergeUndo.orgId, orgId),
          eq(customFieldMergeUndo.entityId, constituentId),
          inArray(
            customFieldMergeUndo.definitionId,
            tx
              .select({ id: customFieldDefinitions.id })
              .from(customFieldDefinitions)
              .where(
                and(
                  eq(customFieldDefinitions.orgId, orgId),
                  eq(customFieldDefinitions.domain, "constituent"),
                ),
              ),
          ),
        ),
      )
      .returning({ id: customFieldMergeUndo.id });

    //    Donation-domain undo rows go only when their definition is
    //    sensitive (Art. 9) — matching exactly the keys step 2 stripped;
    //    non-sensitive donation values were retained, so their undo rows
    //    stay restorable.
    const purgedDonationUndo = await tx
      .delete(customFieldMergeUndo)
      .where(
        and(
          eq(customFieldMergeUndo.orgId, orgId),
          inArray(
            customFieldMergeUndo.definitionId,
            tx
              .select({ id: customFieldDefinitions.id })
              .from(customFieldDefinitions)
              .where(
                and(
                  eq(customFieldDefinitions.orgId, orgId),
                  eq(customFieldDefinitions.domain, "donation"),
                  eq(customFieldDefinitions.sensitive, true),
                ),
              ),
          ),
          inArray(
            customFieldMergeUndo.entityId,
            tx
              .select({ id: donations.id })
              .from(donations)
              .where(and(eq(donations.constituentId, constituentId), eq(donations.orgId, orgId))),
          ),
        ),
      )
      .returning({ id: customFieldMergeUndo.id });
    const undoRowsPurged = purgedConstituentUndo.length + purgedDonationUndo.length;

    // 4. Redact the erased party inside merge_history snapshots. The
    //    snapshots capture full pre/post-merge rows (custom blob
    //    included since migration 0088) — without this they retain the
    //    subject's complete PII indefinitely (Art. 17 gap). Only the
    //    side(s) belonging to the erased party are redacted; the other
    //    party's snapshot is untouched. Idempotent: re-nulling nulls.
    const historyRows = await tx
      .select()
      .from(mergeHistory)
      .where(
        and(
          eq(mergeHistory.orgId, orgId),
          or(eq(mergeHistory.survivorId, constituentId), eq(mergeHistory.mergedId, constituentId)),
        ),
      );
    let mergeHistoryRedacted = 0;
    for (const historyRow of historyRows) {
      const patch: Partial<{
        survivorBefore: unknown;
        survivorAfter: unknown;
        mergedBefore: unknown;
      }> = {};
      if (historyRow.survivorId === constituentId) {
        patch.survivorBefore = redactSnapshot(historyRow.survivorBefore);
        patch.survivorAfter = redactSnapshot(historyRow.survivorAfter);
      }
      if (historyRow.mergedId === constituentId) {
        patch.mergedBefore = redactSnapshot(historyRow.mergedBefore);
      }
      await tx
        .update(mergeHistory)
        .set(patch)
        .where(and(eq(mergeHistory.id, historyRow.id), eq(mergeHistory.orgId, orgId)));
      mergeHistoryRedacted += 1;
    }

    // Counts + definition keys only (schema metadata, not PII) — the
    // erased values themselves never enter the long-retention audit trail.
    await tx.insert(auditLogs).values({
      orgId,
      userId: requestedBy,
      action: "erasure",
      resourceType: "constituent",
      resourceId: constituentId,
      newValues: {
        reason: "gdpr_erasure_request",
        requestedAt,
        customWiped: true,
        donationsSensitiveStripped: donationsStripped,
        sensitiveKeysStripped: sensitiveKeys,
        mergeUndoRowsPurged: undoRowsPurged,
        mergeHistoryRowsRedacted: mergeHistoryRedacted,
      },
    });

    log.info(
      {
        constituentId,
        donationsStripped,
        sensitiveKeyCount: sensitiveKeys.length,
        undoRowsPurged,
        mergeHistoryRedacted,
      },
      "gdpr erasure completed",
    );

    return { status: "erased", constituentId, donationsStripped };
  });
}
