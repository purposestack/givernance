/**
 * Real BullMQ + ioredis end-to-end test against the CI redis service
 * (issue #324).
 *
 * Why this file exists:
 *   PR #321 bumped the CI redis service to `redis:8-alpine`, but the rest
 *   of the suite mocks `bullmq` (`payments.test.ts`, `public-donations.test.ts`)
 *   or calls processors as plain functions (`postal-export.test.ts`) — so
 *   BullMQ's actual Lua scripts (the real Redis-version risk surface) are
 *   never exercised. A breaking BullMQ ↔ Redis-major incompatibility could
 *   ship undetected.
 *
 * What this file covers:
 *   1. Real `Queue` + `Worker` from `bullmq`, connected to the real CI
 *      redis service (no `vi.mock("bullmq", …)`).
 *   2. `removeOnComplete: true` semantics — the `removeJob` Lua script
 *      actually deletes the job hash on Redis 8.
 *   3. DELAYED → ACTIVE transition — BullMQ's delayed-scheduler Lua
 *      promotes a job once its delay elapses.
 *   4. Direct `XADD`/`XREAD` against the same connection — Redis streams
 *      are BullMQ's `QueueEvents` substrate; major-version drift around
 *      stream semantics is the historical risk surface.
 */

import { randomUUID } from "node:crypto";
import { Queue, QueueEvents, Worker } from "bullmq";
import Redis from "ioredis";
import { afterAll, describe, expect, it } from "vitest";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

// Unique prefix per test-file run so a leftover key from a previous run
// (or a parallel job on a shared dev box) can never collide with us.
const RUN_ID = randomUUID();

function newConnection(): Redis {
  return new Redis(REDIS_URL, {
    // Required by BullMQ for blocking commands.
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

describe("BullMQ + ioredis real-Redis end-to-end (issue #324)", () => {
  // One connection per role — Queue, Worker, and QueueEvents each get their
  // own; BullMQ docs recommend not sharing connections across these roles
  // because Worker / QueueEvents use blocking commands.
  const queueConnection = newConnection();
  const eventsConnection = newConnection();
  const sharedConnections: Redis[] = [queueConnection, eventsConnection];

  afterAll(async () => {
    await Promise.all(sharedConnections.map((c) => c.quit()));
  });

  it("processes a real job end-to-end and honours removeOnComplete", async () => {
    const queueName = `e2e-bullmq-${RUN_ID}-basic`;
    const queue = new Queue(queueName, { connection: queueConnection });
    const queueEvents = new QueueEvents(queueName, { connection: eventsConnection });
    await queueEvents.waitUntilReady();

    const workerConnection = newConnection();
    const processed: Array<{ name: string; value: string }> = [];
    const worker = new Worker<{ value: string }>(
      queueName,
      async (job) => {
        processed.push({ name: job.name, value: job.data.value });
        return { ok: true };
      },
      { connection: workerConnection },
    );
    await worker.waitUntilReady();

    try {
      const job = await queue.add(
        "real-bullmq-job",
        { value: "hello-redis-8" },
        { removeOnComplete: true, removeOnFail: true },
      );

      await job.waitUntilFinished(queueEvents);

      expect(processed).toEqual([{ name: "real-bullmq-job", value: "hello-redis-8" }]);

      // `removeOnComplete: true` runs BullMQ's `removeJob` Lua script as
      // part of the finalize transaction. By the time `waitUntilFinished`
      // resolves, the job hash should be gone from Redis. Reading the key
      // directly is what proves the Lua actually executed against this
      // Redis major — a mock would always pass.
      const hashExists = await queueConnection.exists(`bull:${queueName}:${job.id}`);
      expect(hashExists).toBe(0);
    } finally {
      await worker.close();
      await workerConnection.quit();
      await queueEvents.close();
      await queue.close();
    }
  });

  it("promotes a delayed job from DELAYED → ACTIVE once the delay elapses", async () => {
    const queueName = `e2e-bullmq-${RUN_ID}-delayed`;
    const queue = new Queue(queueName, { connection: queueConnection });
    const queueEvents = new QueueEvents(queueName, { connection: eventsConnection });
    await queueEvents.waitUntilReady();

    // Enqueue BEFORE the worker starts so we can observe the `delayed`
    // state without racing the scheduler.
    const delayMs = 300;
    const enqueuedAt = Date.now();
    const job = await queue.add(
      "delayed-job",
      { value: "wait-for-it" },
      { delay: delayMs, removeOnComplete: true },
    );

    expect(await job.getState()).toBe("delayed");

    const workerConnection = newConnection();
    const worker = new Worker(queueName, async () => ({ ok: true }), {
      connection: workerConnection,
    });
    await worker.waitUntilReady();

    try {
      await job.waitUntilFinished(queueEvents);
      const elapsed = Date.now() - enqueuedAt;

      // Generous lower bound: clock skew + scheduler tick can shave a few
      // ms off the nominal delay. The point is that the worker did NOT
      // pick the job up immediately — i.e. BullMQ's delayed-scheduler Lua
      // (`promoteDelayed` / `addDelayedJob`) actually ran on this Redis.
      expect(elapsed).toBeGreaterThanOrEqual(delayMs - 100);
    } finally {
      await worker.close();
      await workerConnection.quit();
      await queueEvents.close();
      await queue.close();
    }
  });

  it("supports Redis streams (XADD/XREAD) — the substrate BullMQ's QueueEvents relies on", async () => {
    const streamKey = `e2e-stream-${RUN_ID}`;
    try {
      const messageId = await queueConnection.xadd(streamKey, "*", "field", "value", "n", "42");
      expect(messageId).toBeTruthy();

      const entries = await queueConnection.xread("COUNT", 1, "STREAMS", streamKey, "0");
      // Shape: [ [ streamKey, [ [ messageId, [field, value, n, "42"] ] ] ] ]
      expect(entries).not.toBeNull();
      const [[readStreamKey, [[readMessageId, fields]]]] = entries as [
        [string, [[string, string[]]]],
      ];
      expect(readStreamKey).toBe(streamKey);
      expect(readMessageId).toBe(messageId);
      expect(fields).toEqual(["field", "value", "n", "42"]);
    } finally {
      await queueConnection.del(streamKey);
    }
  });
});
