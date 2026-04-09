/** Redis client for caching and BullMQ */

import Redis from "ioredis";

/** Shared Redis connection */
export const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});
