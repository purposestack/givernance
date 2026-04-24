/**
 * Outbox Relay — CDC-style poller that moves pending domain events
 * from the PostgreSQL outbox_events table into the BullMQ events queue.
 *
 * Runs on a configurable interval (default 500ms per ADR-005).
 * Each cycle:
 *   1. SELECT rows with status = 'pending' FOR UPDATE SKIP LOCKED (C5 fix — prevents duplicate delivery)
 *   2. Enqueue each into BullMQ givernance_events queue
 *   3. Mark rows as 'completed' (or 'failed' on error)
 */

import { QUEUE_NAMES } from "@givernance/shared/jobs";
import { outboxEvents } from "@givernance/shared/schema";
import { Queue } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import Redis from "ioredis";
import pg from "pg";
import { env } from "./env.js";
import { logger } from "./lib/logger.js";

const BATCH_SIZE = 100;

const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 5,
});

const db = drizzle(pool);

const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const eventsQueue = new Queue(QUEUE_NAMES.EVENTS, { connection: redis });

interface OutboxMetadata {
  traceparent?: string;
  tracestate?: string;
}

async function relayPendingEvents(): Promise<number> {
  // SELECT FOR UPDATE SKIP LOCKED prevents multiple relay instances from racing
  // on the same rows (C5 fix). Each instance locks different pending rows.
  // We now also pull `metadata` so W3C trace-context is propagated to the
  // BullMQ job (issue #56 Platform #4).
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

let running = true;

async function start(): Promise<void> {
  logger.info({ pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS }, "Outbox relay starting");

  while (running) {
    try {
      const count = await relayPendingEvents();
      if (count > 0) {
        logger.info({ count }, "Relayed events");
      }
    } catch (err) {
      logger.error({ err }, "Poll cycle error");
    }

    await new Promise((resolve) => setTimeout(resolve, env.OUTBOX_POLL_INTERVAL_MS));
  }
}

function shutdown(): void {
  logger.info("Shutting down");
  running = false;
  void eventsQueue
    .close()
    .then(() => redis.disconnect())
    .then(() => pool.end());
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start();
