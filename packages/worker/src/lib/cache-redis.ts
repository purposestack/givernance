/** Dedicated Redis connection for application-level caching (not BullMQ queues) */

import Redis from "ioredis";
import { env } from "../env.js";

/**
 * Separate connection from the BullMQ queue connections — BullMQ requires
 * `maxRetriesPerRequest: null` which is a BullMQ-internal contract; the
 * cache connection uses default ioredis settings for clean error propagation.
 */
export const cacheRedis = new Redis(env.REDIS_URL);

/** ExchangeRateCache adapter for injection into ExchangeRateService */
export const exchangeRateRedisCache = {
  get: (key: string) => cacheRedis.get(key),
  set: (key: string, value: string, ttlSeconds: number) =>
    cacheRedis.set(key, value, "EX", ttlSeconds).then(() => undefined),
  del: (key: string) => cacheRedis.del(key).then(() => undefined),
};
