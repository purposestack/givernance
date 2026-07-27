/**
 * Ops helper — enqueue a one-off `receipts.rewrap_deks` sweep (issue
 * #228, KEK rotation). No cron by design: rotation is an explicit,
 * runbook-driven operation.
 *
 * Usage (from repo root, after adding the new KEK version to the
 * keyring / Scaleway and flipping the active version in the env):
 *
 *   REWRAP_REQUESTED_BY="ops@givernance.eu" \
 *     pnpm --filter @givernance/worker run rewrap:trigger
 *
 * The script:
 *   1. Opens a fresh BullMQ Queue against Redis (REDIS_URL).
 *   2. Adds a one-off `receipts.rewrap_deks` job carrying the operator
 *      identity for the audit trail.
 *   3. Logs the job id and exits.
 *
 * The sweep itself runs in the live `worker` process — watch its logs
 * for the `{ scanned, rewrapped, failed }` summary line. The job
 * no-ops (loudly) if the `donation.receipt_envelope_encryption` flag
 * is off — set `REWRAP_FORCE=1` to bypass the gate for EMERGENCY
 * rotation (encrypted rows outlive the flag) — and fails if the
 * RECEIPT_ENCRYPTION_* env vars are absent or invalid on the worker.
 */

import { Queue } from "bullmq";
import IORedis from "ioredis";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const QUEUE_NAME = "receipts";
const JOB_NAME = "receipts.rewrap_deks";

const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue(QUEUE_NAME, { connection });

const requestedBy = process.env.REWRAP_REQUESTED_BY ?? "manual-script";
// REWRAP_FORCE=1 → bypass the feature-flag gate (EMERGENCY rotation:
// encrypted rows outlive the flag, and a compromised-KEK response must
// not require re-enabling encryption platform-wide first).
const force = process.env.REWRAP_FORCE === "1";

const job = await queue.add(
  JOB_NAME,
  { requestedBy, force },
  {
    // One-off, timestamped id — two rotations on the same day must not
    // collapse onto each other, and a sweep is idempotent anyway
    // (already-active rows don't match the predicate).
    jobId: `receipts-rewrap-deks-${Date.now()}`,
    removeOnComplete: true,
    removeOnFail: 50,
  },
);

console.log(
  JSON.stringify(
    {
      enqueued: true,
      queue: QUEUE_NAME,
      jobName: JOB_NAME,
      jobId: job.id,
      requestedBy,
      force,
      hint: "Watch the worker logs for the { scanned, rewrapped, failed } summary.",
    },
    null,
    2,
  ),
);

await queue.close();
await connection.quit();
