/**
 * Outbox Relay — CDC-style poller that moves pending domain events
 * from the PostgreSQL outbox_events table into the BullMQ events queue.
 *
 * Runs on a configurable interval (default 500ms per ADR-005).
 * Each cycle:
 *   1. SELECT rows with status = 'pending' FOR UPDATE SKIP LOCKED (C5 fix — prevents duplicate delivery)
 *   2. Enqueue each into BullMQ givernance_events queue
 *   3. Mark rows as 'completed'. On an enqueue error the row stays
 *      'pending' (error message recorded) and the next cycle retries it.
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

/** Hard ceiling for the SIGTERM drain — one tick is ≤ 100 enqueues, so this is generous. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

let running = true;

async function start(): Promise<void> {
  logger.info({ pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS }, "Outbox relay starting");

  while (running) {
    try {
      const count = await relayPendingEvents(db, eventsQueue, logger, {
        shouldStop: () => !running,
      });
      if (count > 0) {
        logger.info({ count }, "Relayed events");
      }
    } catch (err) {
      logger.error({ err }, "Poll cycle error");
    }

    await new Promise((resolve) => setTimeout(resolve, env.OUTBOX_POLL_INTERVAL_MS));
  }
}

let shuttingDown = false;

/**
 * Graceful shutdown (issue #612). Order matters: stop the loop and WAIT for
 * the in-flight tick before closing anything — closing the queue mid-batch
 * made every remaining `add()` of that batch throw. The tick itself bails
 * out between rows via `shouldStop`, leaving the rest `pending`.
 */
async function shutdown(signal: string, loop: Promise<void>): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down");
  running = false;

  const hardStop = setTimeout(() => {
    logger.error({ signal }, "Graceful shutdown timed out — forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  hardStop.unref();

  try {
    await loop;
    await eventsQueue.close();
    // BullMQ never closes a caller-supplied ioredis instance — quit it here.
    await redis.quit();
    await pool.end();
  } catch (err) {
    logger.error({ err }, "Error during shutdown");
    process.exit(1);
  }
  clearTimeout(hardStop);
  process.exit(0);
}

const loop = start();

process.on("SIGINT", () => void shutdown("SIGINT", loop));
process.on("SIGTERM", () => void shutdown("SIGTERM", loop));
