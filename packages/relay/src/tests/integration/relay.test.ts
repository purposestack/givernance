/**
 * Integration tests for the outbox relay tick (issue #325).
 *
 * Coverage:
 *   1. Happy path — pending row → status='completed' + a BullMQ job carrying
 *      the row's id/tenant/type/payload lands in the events queue.
 *   2. Failure path — when `eventsQueue.add()` rejects, the row transitions
 *      to status='failed' with the error message captured.
 *   3. `FOR UPDATE SKIP LOCKED` — a row locked by an outer transaction is
 *      skipped by the relay (would otherwise block / be duplicated across
 *      replicas); once the lock releases, the relay picks it up.
 *   4. W3C trace-context + impersonation context — metadata.traceparent /
 *      tracestate / impersonation-* fields propagate onto the BullMQ job
 *      payload (issue #56 Platform #4 + issue #24).
 *
 * Why integration (not unit): the `FOR UPDATE SKIP LOCKED` semantics and
 * BullMQ's `Queue.add` Lua scripts only exist in the real Postgres + Redis
 * runtime — mocks would pass for a relay implementation that quietly lost
 * either guarantee. The CI workflow already runs postgres:17 + redis:8
 * service containers (see `.github/workflows/ci.yml`), so this suite reuses
 * the same `givernance_test` database the API + worker packages share.
 */

import { randomUUID } from "node:crypto";
import { QUEUE_NAMES } from "@givernance/shared/jobs";
import { outboxEvents } from "@givernance/shared/schema";
import { Queue } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import Redis from "ioredis";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type RelayLogger, relayPendingEvents } from "../../relay.js";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://givernance:givernance_dev@localhost:5432/givernance_test";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

// Unique per-run namespace for the events queue so a leftover from a
// previous failed run (or a parallel job on a shared dev box) can never
// surface jobs we didn't enqueue.
const RUN_ID = randomUUID();

// `vi.fn()` so tests can assert the failure-path emits a structured log
// with `eventId` + the short error message — a regression that dropped
// the `logger.error(...)` call would otherwise be silent under a bare
// `() => undefined` stub.
type ErrorFn = RelayLogger["error"];
type LoggerSpy = RelayLogger & { error: ReturnType<typeof vi.fn<ErrorFn>> };
const makeLogger = (): LoggerSpy => ({ error: vi.fn<ErrorFn>() });

// `noUncheckedIndexedAccess` makes `rows[0]` always `T | undefined`. Tests
// assert "at least one row came back" so often that a tiny helper is
// cleaner than `if (!row) throw …` at every call site.
function firstOrThrow<T>(rows: readonly T[], description: string): T {
  const head = rows[0];
  if (head === undefined) {
    throw new Error(`expected at least one ${description}, got none`);
  }
  return head;
}

describe("relayPendingEvents — real Postgres + Redis (issue #325)", () => {
  let pool: pg.Pool;
  let db: NodePgDatabase;
  let redis: Redis;
  let queueName: string;
  let queue: Queue;

  // Tenant IDs created during the test; cleaned up in afterEach so each
  // test starts from an empty outbox_events slice for its tenants.
  const usedTenantIds: string[] = [];
  const freshTenantId = (): string => {
    const id = randomUUID();
    usedTenantIds.push(id);
    return id;
  };

  beforeAll(async () => {
    // max: 3 — the SKIP-LOCKED test holds one connection for an outer
    // transaction while the relay tick checks out another; a 3-slot pool
    // leaves headroom without changing the production pool size.
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
    db = drizzle(pool);
    redis = new Redis(REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    queueName = `${QUEUE_NAMES.EVENTS}-test-${RUN_ID}`;
    queue = new Queue(queueName, { connection: redis });
    await queue.waitUntilReady();
  });

  afterAll(async () => {
    // `obliterate` drops every key BullMQ created under `bull:<queueName>:*`.
    // Force=true bypasses the "no active jobs" guard; we never start a
    // Worker in this suite so there are no active jobs anyway.
    await queue.obliterate({ force: true });
    await queue.close();
    redis.disconnect();
    await pool.end();
  });

  // Drain any pending outbox rows left in the shared `givernance_test`
  // database before each test. Other packages (api, worker) write into
  // outbox_events from their own integration suites and don't always clean
  // up the resulting rows — those leftover `pending` rows would otherwise
  // be picked up by the relay tick under test and skew our processed-count
  // assertions. Marking them `completed` (instead of deleting) preserves
  // any audit/foreign-key relationships another test might still inspect.
  beforeEach(async () => {
    await db.execute(
      sql`UPDATE outbox_events
          SET status = 'completed', processed_at = now(), updated_at = now()
          WHERE status = 'pending'`,
    );
  });

  afterEach(async () => {
    for (const tenantId of usedTenantIds) {
      await db.execute(sql`DELETE FROM outbox_events WHERE tenant_id = ${tenantId}::uuid`);
    }
    usedTenantIds.length = 0;
  });

  it("empty tick: returns 0 and calls neither queue.add nor logger.error", async () => {
    const logger = makeLogger();
    const calls: unknown[][] = [];
    const observingQueue = {
      add: async (...args: unknown[]) => {
        calls.push(args);
        return undefined;
      },
    } as unknown as Queue;

    const processed = await relayPendingEvents(db, observingQueue, logger);
    expect(processed).toBe(0);
    expect(calls).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("happy path: marks the pending row completed and enqueues a BullMQ job", async () => {
    const tenantId = freshTenantId();
    const logger = makeLogger();
    const { id } = firstOrThrow(
      await db
        .insert(outboxEvents)
        .values({
          tenantId,
          type: "test.happy",
          payload: { hello: "world" },
        })
        .returning({ id: outboxEvents.id }),
      "outbox insert result",
    );

    const processed = await relayPendingEvents(db, queue, logger);
    expect(processed).toBe(1);
    expect(logger.error).not.toHaveBeenCalled();

    const row = firstOrThrow(
      await db.select().from(outboxEvents).where(eq(outboxEvents.id, id)),
      `outbox_events row ${id}`,
    );
    expect(row.status).toBe("completed");
    expect(row.processedAt).toBeInstanceOf(Date);
    expect(row.error).toBeNull();

    const job = await queue.getJob(id);
    expect(job).toBeDefined();
    expect(job?.name).toBe("test.happy");
    expect(job?.data).toMatchObject({
      id,
      tenantId,
      type: "test.happy",
      payload: { hello: "world" },
    });
  });

  it("failure path: marks the row failed, captures the error, and logs structured event", async () => {
    const tenantId = freshTenantId();
    const logger = makeLogger();
    const { id } = firstOrThrow(
      await db
        .insert(outboxEvents)
        .values({
          tenantId,
          type: "test.fail",
          payload: { v: 1 },
        })
        .returning({ id: outboxEvents.id }),
      "outbox insert result",
    );

    // A real Queue could be made to throw by closing its underlying
    // connection, but the resulting error message would be ioredis-version-
    // specific and brittle. A minimal stub that throws a known error keeps
    // the assertion deterministic and still exercises every line of the
    // relay's catch block (logger.error + UPDATE … SET status='failed').
    const failingQueue = {
      add: async () => {
        throw new Error("redis is down");
      },
    } as unknown as Queue;

    const processed = await relayPendingEvents(db, failingQueue, logger);
    expect(processed).toBe(0);

    const row = firstOrThrow(
      await db.select().from(outboxEvents).where(eq(outboxEvents.id, id)),
      `outbox_events row ${id}`,
    );
    expect(row.status).toBe("failed");
    expect(row.error).toBe("redis is down");
    expect(row.processedAt).toBeNull();

    // Lock the log shape so a regression that drops `eventId` from the
    // structured payload (e.g. someone replacing the object with a plain
    // string) is caught — pino's redact list keys off `err.*` paths, so
    // the short-string `err: message` form here is also the safer choice
    // for never accidentally serialising a stack-trace that embeds a
    // connection string into the log.
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      { eventId: id, err: "redis is down" },
      "Failed to relay event",
    );
  });

  it("SKIP LOCKED: a row locked by another transaction is skipped, picked up after release", async () => {
    const tenantId = freshTenantId();
    const logger = makeLogger();
    const inserted = await db
      .insert(outboxEvents)
      .values(
        Array.from({ length: 5 }, (_, i) => ({
          tenantId,
          type: `test.skip-locked.${i}`,
          payload: { i },
        })),
      )
      .returning({ id: outboxEvents.id });
    expect(inserted).toHaveLength(5);

    // The relay orders by created_at ASC, so the first-inserted row is the
    // one it would naturally pick up first. Locking that row is the
    // strongest demonstration that SKIP LOCKED actually skips ahead.
    const lockedId = firstOrThrow(inserted, "inserted outbox row").id;
    const otherIds = inserted.slice(1).map((r) => r.id);

    const lockingClient = await pool.connect();
    // Always ROLLBACK + release in finally so a mid-test assertion failure
    // can't return an in-transaction connection to the pool (which would
    // surface as "current transaction is aborted" errors on the next test
    // that draws this client from the pool). The ROLLBACK is a no-op if
    // BEGIN never ran.
    try {
      await lockingClient.query("BEGIN");
      const locked = await lockingClient.query(
        "SELECT id FROM outbox_events WHERE id = $1 FOR UPDATE",
        [lockedId],
      );
      expect(locked.rows).toHaveLength(1);

      // Without SKIP LOCKED, this call would block on the held row's lock
      // (and the test would time out). With SKIP LOCKED, the relay walks
      // past the locked row and processes the remaining 4.
      const processed = await relayPendingEvents(db, queue, logger);
      expect(processed).toBe(4);

      const lockedRow = firstOrThrow(
        await db.select().from(outboxEvents).where(eq(outboxEvents.id, lockedId)),
        `outbox_events row ${lockedId}`,
      );
      expect(lockedRow.status).toBe("pending");

      // Positive BullMQ-side proof: the 4 unlocked rows landed as jobs,
      // and the locked row did NOT — closes the gap that the
      // processed-count alone could be satisfied by enqueueing the wrong
      // 4 rows by accident.
      expect(await queue.getJob(lockedId)).toBeUndefined();
      for (const otherId of otherIds) {
        const job = await queue.getJob(otherId);
        expect(job, `expected job for unlocked row ${otherId}`).toBeDefined();
      }
    } finally {
      await lockingClient.query("ROLLBACK").catch(() => undefined);
      lockingClient.release();
    }

    // Lock released — a second tick now picks up the previously-locked row.
    const processedAfter = await relayPendingEvents(db, queue, logger);
    expect(processedAfter).toBe(1);

    const finalRow = firstOrThrow(
      await db.select().from(outboxEvents).where(eq(outboxEvents.id, lockedId)),
      `outbox_events row ${lockedId}`,
    );
    expect(finalRow.status).toBe("completed");
    expect(await queue.getJob(lockedId)).toBeDefined();
    expect(logger.error).not.toHaveBeenCalled();
  });

  // Cover BOTH impersonation modes — `docs/19-impersonation.md` §6 makes
  // clear pure-impersonation is allowed to write (exact RBAC parity with
  // the target), so its metadata round-trips through the outbox just like
  // delegation. A regression that dropped pure-impersonation context
  // before enqueueing would silently break the double-attribution audit
  // trail that the impersonation epic depends on.
  it.each([
    { mode: "delegation" as const, name: "delegation" },
    { mode: "impersonation" as const, name: "pure-impersonation" },
  ])("trace + $name context: metadata fields land on the BullMQ job", async ({ mode }) => {
    const tenantId = freshTenantId();
    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const tracestate = "vendor=opaque";
    const impersonationSessionId = randomUUID();
    const impersonatorKeycloakId = randomUUID();

    const { id } = firstOrThrow(
      await db
        .insert(outboxEvents)
        .values({
          tenantId,
          type: "test.trace",
          payload: { v: 1 },
          metadata: {
            traceparent,
            tracestate,
            impersonationSessionId,
            impersonationMode: mode,
            impersonatorKeycloakId,
          },
        })
        .returning({ id: outboxEvents.id }),
      "outbox insert result",
    );

    const processed = await relayPendingEvents(db, queue, makeLogger());
    expect(processed).toBe(1);

    const job = await queue.getJob(id);
    expect(job).toBeDefined();
    expect(job?.data).toMatchObject({
      id,
      tenantId,
      type: "test.trace",
      traceparent,
      tracestate,
      impersonationSessionId,
      impersonationMode: mode,
      impersonatorKeycloakId,
    });
    // Lock the negative shape: the relay must NOT forward the raw
    // metadata object onto the job (which would defeat the per-field
    // contract above and risk leaking unrelated future metadata fields).
    expect(job?.data).not.toHaveProperty("metadata");
  });
});
