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

const POLL_INTERVAL_MS = Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? "500");
const BATCH_SIZE = 100;

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgresql://givernance:givernance_dev@localhost:5432/givernance",
  max: 5,
});

const db = drizzle(pool);

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const eventsQueue = new Queue(QUEUE_NAMES.EVENTS, { connection: redis });

async function relayPendingEvents(): Promise<number> {
  // SELECT FOR UPDATE SKIP LOCKED prevents multiple relay instances from racing
  // on the same rows (C5 fix). Each instance locks different pending rows.
  const pending = await db.execute<{
    id: string;
    tenant_id: string;
    type: string;
    payload: unknown;
  }>(
    sql`SELECT id, tenant_id, type, payload
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
      console.error(`[outbox-relay] Failed to relay event ${row.id}:`, message);

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
  console.warn(`[outbox-relay] Starting — polling every ${POLL_INTERVAL_MS}ms`);

  while (running) {
    try {
      const count = await relayPendingEvents();
      if (count > 0) {
        console.warn(`[outbox-relay] Relayed ${count} events`);
      }
    } catch (err) {
      console.error("[outbox-relay] Poll cycle error:", err);
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

function shutdown(): void {
  console.warn("[outbox-relay] Shutting down…");
  running = false;
  void eventsQueue
    .close()
    .then(() => redis.disconnect())
    .then(() => pool.end());
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start();
