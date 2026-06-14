/**
 * Dev helper — enqueue a one-off `notifications.digest_daily` job so an
 * operator can validate the email digest path without waiting for the
 * 09:00 UTC cron tick (Epic #363, Phase 5).
 *
 * Usage (from repo root):
 *
 *   pnpm --filter @givernance/worker run digest:trigger
 *
 * The script:
 *   1. Opens a fresh BullMQ Queue against the local Redis.
 *   2. Adds a NON-repeatable job with `since = 7 days ago` (the worker
 *      clamps to MAX_SINCE_WINDOW_MS anyway, so this just maximises the
 *      replay window — every unread row from the past week is eligible).
 *   3. Logs the job id and exits.
 *
 * The actual send happens in the running `worker` process — make sure
 * `pnpm --filter @givernance/worker dev` is up, then watch its log and
 * Mailpit at http://localhost:8025.
 *
 * Pre-flight (otherwise you'll see "Sent 0"):
 *   - User has at least one `notification_preferences.email_digest = true`
 *     row (toggle from /profile/notifications or via SQL).
 *   - User has an unread `notifications` row whose `type` matches the
 *     preference row.
 */

import { Queue } from "bullmq";
import IORedis from "ioredis";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const QUEUE_NAME = "notifications_digest";
const JOB_NAME = "notifications.digest_daily";

const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue(QUEUE_NAME, { connection });

const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

const job = await queue.add(
  JOB_NAME,
  { since },
  {
    // One-off — no repeat. Distinct from the scheduled
    // `notifications-digest-daily` repeatable so adding this doesn't
    // collide with the cron registration on the next worker boot.
    jobId: `notifications-digest-oneoff-${Date.now()}`,
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
      since,
      hint: "Watch the worker logs + open http://localhost:8025 for the rendered email.",
    },
    null,
    2,
  ),
);

await queue.close();
await connection.quit();
