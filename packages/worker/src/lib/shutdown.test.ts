/**
 * Unit tests — worker graceful shutdown (issue #612).
 * Pure fakes: no Redis, no BullMQ, no pg.
 */

import { describe, expect, it, vi } from "vitest";
import { createGracefulShutdown, type ShutdownLogger } from "./shutdown.js";

type LogFn = ShutdownLogger["info"];
function makeLogger() {
  return { info: vi.fn<LogFn>(), warn: vi.fn<LogFn>(), error: vi.fn<LogFn>() };
}

/** A promise whose resolution the test controls — stands in for an active job. */
function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("createGracefulShutdown", () => {
  it("drains workers first, then closes queues, redis and pg pools, then exits 0", async () => {
    const order: string[] = [];
    const activeJob = deferred();
    const exit = vi.fn();

    const shutdown = createGracefulShutdown({
      workers: [
        {
          name: "receipts",
          // BullMQ's `worker.close()` resolves only once active jobs settle.
          close: async () => {
            order.push("worker:close-called");
            await activeJob.promise;
            order.push("worker:drained");
          },
        },
      ],
      queues: [{ close: async () => void order.push("queue") }],
      connections: [{ quit: async () => void order.push("redis") }],
      closePools: async () => void order.push("pg"),
      logger: makeLogger(),
      timeoutMs: 5_000,
      exit,
    });

    const done = shutdown("SIGTERM");
    await Promise.resolve();
    // Nothing downstream is torn down while a job is still running.
    expect(order).toEqual(["worker:close-called"]);
    expect(exit).not.toHaveBeenCalled();

    activeJob.resolve();
    await done;

    expect(order).toEqual(["worker:close-called", "worker:drained", "queue", "redis", "pg"]);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("ignores a repeated signal while the drain is in flight", async () => {
    const activeJob = deferred();
    const close = vi.fn(async () => activeJob.promise);
    const exit = vi.fn();
    const logger = makeLogger();

    const shutdown = createGracefulShutdown({
      workers: [{ name: "emails", close }],
      queues: [],
      connections: [],
      closePools: async () => {},
      logger,
      timeoutMs: 5_000,
      exit,
    });

    const first = shutdown("SIGTERM");
    const second = shutdown("SIGINT");
    expect(second).toBe(first);

    activeJob.resolve();
    await first;

    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { signal: "SIGINT" },
      "Shutdown already in progress — ignoring repeated signal",
    );
  });

  it("forces exit 1 when a hung job outlives the hard timeout", async () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn();
      const logger = makeLogger();
      const closePools = vi.fn(async () => {});

      const shutdown = createGracefulShutdown({
        // Never resolves — a job stuck on a dead socket.
        workers: [{ name: "postal_exports", close: () => new Promise<void>(() => {}) }],
        queues: [],
        connections: [],
        closePools,
        logger,
        timeoutMs: 25_000,
        exit,
      });

      void shutdown("SIGTERM");
      await vi.advanceTimersByTimeAsync(24_999);
      expect(exit).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);
      expect(closePools).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps going when one cleanup step throws — later resources are still released", async () => {
    const exit = vi.fn();
    const logger = makeLogger();
    const closePools = vi.fn(async () => {});
    const healthyWorkerClose = vi.fn(async () => {});

    const shutdown = createGracefulShutdown({
      workers: [
        {
          name: "webhooks",
          close: async () => {
            throw new Error("Connection is closed.");
          },
        },
        { name: "receipts", close: healthyWorkerClose },
      ],
      queues: [],
      connections: [],
      closePools,
      logger,
      timeoutMs: 5_000,
      exit,
    });

    await shutdown("SIGTERM");

    expect(healthyWorkerClose).toHaveBeenCalledTimes(1);
    expect(closePools).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      { step: "worker:webhooks", err: "Connection is closed." },
      "Shutdown step failed — continuing",
    );
    expect(exit).toHaveBeenCalledWith(0);
  });
});
