/**
 * Outbox Relay — CDC-style poller that moves pending domain events
 * from the PostgreSQL outbox_events table into the BullMQ events queue.
 *
 * Runs on a configurable interval (default 500ms per ADR-005).
 * Each cycle:
 *   1. SELECT rows with status = 'pending' FOR UPDATE SKIP LOCKED (C5 fix — prevents duplicate delivery)
 *   2. Enqueue each into BullMQ givernance_events queue
 *   3. Mark rows as 'completed' (or 'failed' on error)
 *
 * The poll-tick logic itself lives in `./relay.ts` so the integration test
 * suite (issue #325) can exercise it against a real Postgres + Redis without
 * starting the polling loop.
 */

import { QUEUE_NAMES } from "@givernance/shared/jobs";
import { Queue } from "bullmq";
import { drizzle } from "drizzle-orm/node-postgres";
import Redis from "ioredis";
import pg from "pg";
import { env } from "./env.js";
import { logger } from "./lib/logger.js";
import { relayPendingEvents } from "./relay.js";

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

let running = true;

async function start(): Promise<void> {
  logger.info({ pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS }, "Outbox relay starting");

  while (running) {
    try {
      const count = await relayPendingEvents(db, eventsQueue, logger);
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
