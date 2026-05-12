/**
 * Shared Redis connection for non-BullMQ use cases in the worker
 * (e.g. the per-email resend rate-limit bucket, F3 post-review).
 *
 * BullMQ queue/worker connections live elsewhere (`worker.ts`,
 * `queues/index.ts`) and must use their own `Redis` instances per BullMQ's
 * best practices; this one is for ad-hoc `INCR` / `GET` / `SET` from
 * inside processors.
 */

import Redis from "ioredis";
import { env } from "../env.js";

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});
