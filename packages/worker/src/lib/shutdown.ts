/**
 * Graceful shutdown for the worker process (issue #612).
 *
 * Every Kamal deploy sends SIGTERM to the old container. Without a
 * handler Node dies immediately: in-flight jobs are cut mid-transaction
 * and only come back through BullMQ's stalled-job sweep (which re-runs
 * them regardless of `attempts`). The sequence here:
 *
 *   1. `worker.close()` on every Worker — stops fetching new jobs and
 *      WAITS for the active ones to settle.
 *   2. Close the Queue handles (producers are idle once workers are).
 *   3. `quit()` the ioredis connections we created ourselves. BullMQ
 *      treats a caller-supplied ioredis instance as shared and never
 *      closes it, so this is on us.
 *   4. End both pg pools.
 *   5. Exit 0.
 *
 * A hard timeout bounds the whole thing so one hung job cannot block a
 * deploy forever; it exits 1 and the unfinished job is recovered by the
 * next container's stalled-job check. Factored out of `worker.ts` (no
 * env / Redis / pg imports) so it is unit-testable with fakes.
 */

export interface ShutdownLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface GracefulShutdownDeps {
  workers: ReadonlyArray<{ name: string; close(): Promise<void> }>;
  queues: ReadonlyArray<{ close(): Promise<void> }>;
  /** ioredis connections created by this process (NOT closed by BullMQ). */
  connections: ReadonlyArray<{ quit(): Promise<unknown> }>;
  /** Ends the pg pools. */
  closePools: () => Promise<void>;
  logger: ShutdownLogger;
  /** Hard ceiling for the whole drain, in ms. */
  timeoutMs: number;
  /** Injected for tests; `process.exit` in production. */
  exit: (code: number) => void;
}

/** Run a cleanup step; log and continue on failure so later steps still run. */
async function step(logger: ShutdownLogger, name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (err) {
    logger.error(
      { step: name, err: err instanceof Error ? err.message : String(err) },
      "Shutdown step failed — continuing",
    );
  }
}

/**
 * Build the signal handler. Idempotent: a second signal while the drain
 * is in flight is logged and returns the same promise.
 */
export function createGracefulShutdown(
  deps: GracefulShutdownDeps,
): (signal: string) => Promise<void> {
  const { workers, queues, connections, closePools, logger, timeoutMs, exit } = deps;
  let inFlight: Promise<void> | null = null;

  return (signal: string) => {
    if (inFlight) {
      logger.warn({ signal }, "Shutdown already in progress — ignoring repeated signal");
      return inFlight;
    }

    inFlight = (async () => {
      logger.info({ signal, workers: workers.length, timeoutMs }, "Shutting down — draining jobs");

      let timedOut = false;
      const hardStop = setTimeout(() => {
        timedOut = true;
        logger.error(
          { signal, timeoutMs },
          "Graceful shutdown timed out — forcing exit (active jobs will be recovered as stalled)",
        );
        exit(1);
      }, timeoutMs);
      // Never let the timer itself keep the process alive.
      hardStop.unref();

      await Promise.all(workers.map((w) => step(logger, `worker:${w.name}`, () => w.close())));
      await Promise.all(queues.map((q) => step(logger, "queue", () => q.close())));
      await Promise.all(connections.map((c) => step(logger, "redis", () => c.quit())));
      await step(logger, "pg-pools", closePools);

      clearTimeout(hardStop);
      if (timedOut) return;
      logger.info({ signal }, "Shutdown complete");
      exit(0);
    })();

    return inFlight;
  };
}
