import { ExchangeRateService as SharedExchangeRateService } from "@givernance/shared";
import pino from "pino";
import { env } from "../../env.js";
import { db } from "../../lib/db.js";
import { redis } from "../../lib/redis.js";

const exchangeRateLogger = pino({
  level: env.LOG_LEVEL,
  base: { service: "givernance-api", module: "exchange-rate-service" },
});

/** Redis-backed ExchangeRateCache adapter — keys: `fx:{src}:{tgt}:{date}` */
const redisCache = {
  get: (key: string) => redis.get(key),
  set: (key: string, value: string, ttlSeconds: number) =>
    redis.set(key, value, "EX", ttlSeconds).then(() => undefined),
  del: (key: string) => redis.del(key).then(() => undefined),
};

interface ExchangeRateServiceOptions {
  dbClient?: Pick<typeof db, "select" | "insert">;
  fetchImpl?: typeof fetch;
  logger?: { warn: (...args: unknown[]) => void };
}

export class ExchangeRateService extends SharedExchangeRateService {
  constructor(options: ExchangeRateServiceOptions = {}) {
    super({
      apiKey: process.env.EXCHANGE_RATE_API_KEY ?? env.EXCHANGE_RATE_API_KEY,
      cache: redisCache,
      dbClient: options.dbClient ?? db,
      fetchImpl: options.fetchImpl,
      logger: options.logger ?? exchangeRateLogger,
    });
  }
}
