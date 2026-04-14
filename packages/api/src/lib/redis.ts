/** Redis client for caching and BullMQ */

import Redis from "ioredis";
import { env } from "../env.js";

/** Shared Redis connection */
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});
