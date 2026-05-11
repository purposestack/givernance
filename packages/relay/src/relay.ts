/**
 * Outbox relay tick — pure logic, factored out of `index.ts` so the
 * row-locking + enqueue + completion-marking semantics can be exercised
 * by an integration test against a real Postgres + real Redis (issue
 * #325) without booting the long-lived polling loop or the env-driven
 * singletons.
 *
 * `index.ts` is the entrypoint that wires env → pool → drizzle → Queue
 * and calls this function on a timer. Tests construct their own db +
 * queue and call `relayPendingEvents` directly.
 */

import { type OutboxMetadata, outboxEvents } from "@givernance/shared/schema";
import type { Queue } from "bullmq";
import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

/** Max rows lifted out of `outbox_events` per tick. */
export const BATCH_SIZE = 100;

/**
 * Minimal logger surface so the test suite can pass a silent stub instead
 * of pulling pino into every test file. Mirrors the `error` call site in
 * the failure path below.
 */
export interface RelayLogger {
  error(obj: Record<string, unknown>, msg: string): void;
}

/**
 * One poll tick: lock up to `BATCH_SIZE` pending rows with `FOR UPDATE
 * SKIP LOCKED`, enqueue each into BullMQ, and mark the row `completed`
 * (or `failed` on enqueue error). Returns the count of rows successfully
 * enqueued + marked `completed`.
 *
 * The `FOR UPDATE SKIP LOCKED` clause is what makes this safe to run from
 * multiple relay replicas at once — each replica locks a disjoint subset
 * of pending rows for the duration of the tick.
 */
export async function relayPendingEvents(
  db: NodePgDatabase,
  eventsQueue: Queue,
  logger: RelayLogger,
): Promise<number> {
  const pending = await db.execute<{
    id: string;
    tenant_id: string;
    type: string;
    payload: unknown;
    metadata: OutboxMetadata | null;
  }>(
    sql`SELECT id, tenant_id, type, payload, metadata
        FROM outbox_events
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED`,
  );

  let processed = 0;

  for (const row of pending.rows) {
    try {
      await eventsQueue.add(
        row.type,
        {
          id: row.id,
          tenantId: row.tenant_id,
          type: row.type,
          payload: row.payload,
          // Forward the traceparent so the worker's jobLogger can bind
          // traceId/spanId. Jobs written before this change have null metadata.
          traceparent: row.metadata?.traceparent,
          tracestate: row.metadata?.tracestate,
          // Issue #24 — forward impersonation context to the worker so
          // async audit writes can carry the same double-attribution as
          // the originating request. Optional on every job; only delegation
          // mode produces non-null values (pure-impersonation can't write).
          impersonationSessionId: row.metadata?.impersonationSessionId,
          impersonationMode: row.metadata?.impersonationMode,
          impersonatorKeycloakId: row.metadata?.impersonatorKeycloakId,
        },
        {
          jobId: row.id,
          attempts: 5,
          backoff: { type: "exponential", delay: 1000 },
          removeOnComplete: 1000,
          removeOnFail: 5000,
        },
      );

      await db
        .update(outboxEvents)
        .set({
          status: "completed",
          processedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(outboxEvents.id, row.id));

      processed++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ eventId: row.id, err: message }, "Failed to relay event");

      await db
        .update(outboxEvents)
        .set({
          status: "failed",
          error: message,
          updatedAt: new Date(),
        })
        .where(eq(outboxEvents.id, row.id));
    }
  }

  return processed;
}
