/**
 * Shared BullMQ `defaultJobOptions` (issue #612).
 *
 * BullMQ reads retry + retention settings from the **Queue** that
 * `add()`s the job (`Queue#add` merges `defaultJobOptions` under the
 * per-add opts) — a `Worker` constructor silently ignores
 * `attempts` / `backoff`. And `defaultJobOptions` are per Queue
 * *instance*, not stored in Redis: every process that produces onto a
 * queue (worker router, API routes, ops scripts) must build its handle
 * with the same options. Hence this lives in `@givernance/shared`.
 *
 * Deliberately structural (no `bullmq` import) so the shared package
 * keeps zero queue dependencies; the shape is assignable to BullMQ's
 * `DefaultJobOptions`.
 */

/** `KeepJobs` — `age` is in SECONDS (BullMQ convention), `count` caps the set. */
export interface JobRetention {
  age: number;
  count: number;
}

export interface QueueDefaultJobOptions {
  attempts: number;
  backoff: { type: "exponential"; delay: number };
  removeOnComplete: JobRetention;
  removeOnFail: JobRetention;
}

const HOUR_S = 60 * 60;
const DAY_S = 24 * HOUR_S;

/**
 * Baseline for every queue without a bespoke policy.
 *
 *  - 3 attempts, exponential backoff from 30s (retries at +30s, +60s) —
 *    rides out a managed-Postgres failover or a Keycloak restart.
 *  - Completed jobs: 24h / 1000. Long enough that a relay redelivery of
 *    the same outbox row still dedupes on its `jobId`; bounded so Redis
 *    doesn't grow forever.
 *  - Failed jobs (the DLQ, ADR-020): 14 days / 500 — inside ADR-020's
 *    30-day ceiling, generous enough to triage a burst.
 *
 * Retention is evaluated lazily by BullMQ (when the next job of the
 * same kind finishes), so `age` is a lower bound, not a timer.
 */
export const DEFAULT_JOB_OPTIONS: QueueDefaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 30_000 },
  removeOnComplete: { age: DAY_S, count: 1000 },
  removeOnFail: { age: 14 * DAY_S, count: 500 },
};

/**
 * Per-queue deviations from the baseline. Keyed by queue NAME (the
 * `QUEUE_NAMES` values) — kept as string literals so this file does not
 * import `./index` (which re-exports it).
 */
const QUEUE_OVERRIDES: Record<string, Partial<QueueDefaultJobOptions>> = {
  // Bulk import is NOT retry-safe yet: a re-run of a `processing` row
  // restarts from row 0 and double-counts / re-processes every batch
  // already committed. Keep a single attempt (the operator re-uploads)
  // until the processor learns to resume from `processed_rows`
  // (follow-up to issue #612). Retention is still bounded.
  bulk_import: { attempts: 1 },
  // Stripe webhook payloads carry donor PII (email, name, billing
  // details). The durable record is the `webhook_events` row, not the
  // Redis job — drop completed jobs quickly. Failed jobs keep the
  // baseline so a terminal failure stays replayable from BullBoard.
  webhooks: { removeOnComplete: { age: HOUR_S, count: 100 } },
};

/** `defaultJobOptions` for a queue — baseline merged with its override. */
export function defaultJobOptionsFor(queueName: string): QueueDefaultJobOptions {
  return { ...DEFAULT_JOB_OPTIONS, ...QUEUE_OVERRIDES[queueName] };
}
