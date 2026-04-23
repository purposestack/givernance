/**
 * Tenant-lifecycle processor — nightly expire pass for the provisional-admin
 * grace window (issue #113 / ADR-016 / doc 22 §3.1).
 *
 * Runs as a BullMQ repeatable job. Safe to run more than once per night — the
 * expire logic is idempotent (it only touches rows whose `provisional_until`
 * is already in the past, and never overwrites rows with an open dispute).
 */

import { auditLogs, outboxEvents, tenantAdminDisputes, users } from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, withWorkerContext } from "../lib/db.js";
import { jobLogger } from "../lib/logger.js";

/**
 * `tenant.provisional-admin-expire` — one pass across every org whose first
 * admin's provisional_until has elapsed. For each org:
 *  - If an open dispute exists: skip (resolution is manual).
 *  - Otherwise: clear `provisional_until`, emit audit + outbox confirming
 *    the admin.
 */
export async function processTenantLifecycle(job: Job): Promise<void> {
  const log = jobLogger({ jobId: job.id, tenantId: "system" });
  if (job.name !== "tenant.provisional-admin-expire") {
    log.warn({ name: job.name }, "Unknown tenant-lifecycle job name");
    return;
  }

  const now = new Date();
  const candidates = await db
    .select({ userId: users.id, orgId: users.orgId })
    .from(users)
    .where(and(eq(users.firstAdmin, true), sql`${users.provisionalUntil} <= ${now}`));

  let confirmed = 0;
  let skipped = 0;

  for (const row of candidates) {
    const [openDispute] = await db
      .select({ id: tenantAdminDisputes.id })
      .from(tenantAdminDisputes)
      .where(and(eq(tenantAdminDisputes.orgId, row.orgId), isNull(tenantAdminDisputes.resolution)))
      .limit(1);

    if (openDispute) {
      skipped += 1;
      continue;
    }

    try {
      // DATA-7: make the clear+emit idempotent against overlapping workers.
      // `UPDATE ... WHERE provisional_until IS NOT NULL RETURNING id` means
      // only one of two racing workers will see a RETURNING row; the other
      // no-ops and skips the outbox emit.
      const claimed = await withWorkerContext(row.orgId, async (tx) => {
        const updated = await tx
          .update(users)
          .set({ provisionalUntil: null, updatedAt: new Date() })
          .where(
            and(
              eq(users.id, row.userId),
              sql`${users.provisionalUntil} IS NOT NULL`,
              eq(users.firstAdmin, true),
            ),
          )
          .returning({ id: users.id });
        if (updated.length === 0) return false;

        await tx.insert(outboxEvents).values({
          tenantId: row.orgId,
          type: "tenant.provisional_admin_confirmed",
          payload: { tenantId: row.orgId, userId: row.userId },
        });

        await tx.insert(auditLogs).values({
          orgId: row.orgId,
          userId: null,
          action: "tenant.provisional_admin_confirmed",
          resourceType: "user",
          resourceId: row.userId,
          newValues: { provisionalUntil: null },
        });
        return true;
      });
      if (claimed) confirmed += 1;
      else skipped += 1;
    } catch (err) {
      log.error({ err, orgId: row.orgId }, "Failed to confirm provisional admin");
    }
  }

  log.info({ confirmed, skipped }, "Provisional-admin expire pass complete");
}
