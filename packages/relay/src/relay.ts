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

/** Per-tick knobs. */
export interface RelayTickOptions {
  /**
   * Polled before each row. When it returns true the tick stops early and
   * leaves the rest of the batch `pending` for the next tick / next relay
   * instance — this is how `index.ts` shuts down without enqueueing into a
   * queue that is about to close (issue #612).
   */
  shouldStop?: () => boolean;
}

/**
 * One poll tick: lock up to `BATCH_SIZE` pending rows with `FOR UPDATE
 * SKIP LOCKED`, enqueue each into BullMQ, and mark the row `completed`.
 * Returns the count of rows successfully enqueued + marked `completed`.
 *
 * Enqueue errors (issue #612): the row STAYS `pending` — only the `error`
 * column records what happened — and the tick stops at the first failure.
 * Nothing ever re-queued a `failed` row, so the old "mark failed" behaviour
 * turned a transient Redis blip into permanently lost domain events.
 * Leaving the row pending is safe because `jobId: row.id` makes the retry
 * idempotent; stopping the batch avoids hammering a Redis that just failed
 * (the next tick, one poll interval later, is the retry/backoff).
 *
 * The `FOR UPDATE SKIP LOCKED` clause lets multiple relay replicas tick
 * the same table concurrently without blocking on each other. Note that
 * the SELECT runs in autocommit (via `db.execute`), so the row locks are
 * released the moment the SELECT returns — they do NOT span the
 * subsequent UPDATE. What actually guarantees exactly-once *delivery* is
 * the `jobId: row.id` option on `eventsQueue.add` below: BullMQ rejects
 * duplicate jobIds at the queue level, so a row picked up by two replicas
 * in the same tick produces only one job. The SKIP LOCKED clause is a
 * latency optimisation (replicas don't fight for the same row) on top of
 * that idempotency guarantee, not a substitute for it.
 */
export async function relayPendingEvents(
  db: NodePgDatabase,
  eventsQueue: Queue,
  logger: RelayLogger,
  options: RelayTickOptions = {},
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
    if (options.shouldStop?.()) break;

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
          // the originating request. Optional on every job; both
          // `delegation` and `impersonation` (pure) modes can produce
          // non-null values because pure-impersonation has full RBAC
          // parity with the target and is allowed to write
          // (docs/19-impersonation.md §6).
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ eventId: row.id, err: message }, "Failed to relay event");

      // Status deliberately untouched (`pending`) — see the function doc.
      await db
        .update(outboxEvents)
        .set({ error: message, updatedAt: new Date() })
        .where(eq(outboxEvents.id, row.id));
      break;
    }

    // Outside the try: if THIS update throws, the row stays `pending` and
    // the next tick re-adds the same jobId — a no-op in BullMQ.
    await db
      .update(outboxEvents)
      .set({
        status: "completed",
        // Clear a message left by an earlier failed attempt.
        error: null,
        processedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(outboxEvents.id, row.id));

    processed++;
  }

  return processed;
}
