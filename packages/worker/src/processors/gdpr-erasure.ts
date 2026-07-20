/** Job processor — GDPR right-to-erasure (Art. 17) */

import type { GdprErasureJob } from "@givernance/shared/jobs";
import {
  auditLogs,
  constituents,
  customFieldDefinitions,
  donations,
} from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { and, eq, sql } from "drizzle-orm";
import { withWorkerContext } from "../lib/db.js";
import { jobLogger } from "../lib/logger.js";

/**
 * Anonymize a constituent's PII per GDPR erasure request.
 *
 * One transaction, three steps (Epic #539 / docs/35 §6):
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
 *   3. One counts-only audit row (never the erased values themselves).
 *
 * Erasure ALWAYS runs regardless of feature-flag state — no
 * `isFlagEnabled` gate, ever. Idempotent: a re-delivered job re-writes
 * the same placeholders and strips nothing new.
 */
export async function processGdprErasure(job: Job<GdprErasureJob["data"]>) {
  const { orgId, constituentId, requestedBy, requestedAt } = job.data;
  const log = jobLogger({ tenantId: orgId, jobId: job.id });

  return withWorkerContext(orgId, async (tx) => {
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
      },
    });

    log.info(
      { constituentId, donationsStripped, sensitiveKeyCount: sensitiveKeys.length },
      "gdpr erasure completed",
    );

    return { status: "erased", constituentId, donationsStripped };
  });
}
