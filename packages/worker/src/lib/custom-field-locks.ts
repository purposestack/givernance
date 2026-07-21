/**
 * Custom-field VALUES advisory lock (Epic #539, docs/35 §6).
 *
 * One transaction-scoped, per-org advisory lock shared by every worker
 * transaction that rewrites stored custom values from OUTSIDE a request
 * context: GDPR erasure, the option-merge backfill chunks, and the
 * merge-undo restore chunks. All three are read-modify-write pipelines
 * whose statements can otherwise interleave across worker processes
 * (gdprWorker and the custom-fields worker run concurrently):
 *
 *   - a backfill chunk that scanned rows BEFORE an erasure committed
 *     would re-add the merged key onto the just-wiped blob and insert
 *     undo rows carrying pre-erasure values AFTER the erasure purged
 *     the subject's undo store (30-day Art. 9 retention leak),
 *   - an undo-restore chunk that read undo rows BEFORE the erasure
 *     purge committed would replay pre-erasure values onto the erased
 *     entity (the donation domain has no `deleted_at` second wall).
 *
 * Taking this lock FIRST in each of those transactions serialises the
 * pipelines per org: whichever commits first, the other observes its
 * committed state. Chunks are bounded (≤ 500 rows) and erasure is rare,
 * so the serialisation cost is negligible. Same `hashtext` keying
 * convention as the API's `acquireQuotaLock`.
 */

import { sql } from "drizzle-orm";

/** Minimal executor shape — matches the Drizzle tx `withWorkerContext` yields. */
interface SqlExecutor {
  execute(query: ReturnType<typeof sql>): Promise<unknown>;
}

export async function acquireCustomFieldValuesLock(tx: SqlExecutor, orgId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`custom_fields:values:${orgId}`}))`);
}
