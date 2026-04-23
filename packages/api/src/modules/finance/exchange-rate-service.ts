import { ExchangeRateService as SharedExchangeRateService } from "@givernance/shared";
import pino from "pino";
import { env } from "../../env.js";
import { db } from "../../lib/db.js";

const exchangeRateLogger = pino({
  level: env.LOG_LEVEL,
  base: { service: "givernance-api", module: "exchange-rate-service" },
});

interface ExchangeRateServiceOptions {
  dbClient?: Pick<typeof db, "select" | "insert">;
  fetchImpl?: typeof fetch;
  logger?: { warn: (...args: unknown[]) => void };
}

export class ExchangeRateService extends SharedExchangeRateService {
  constructor(options: ExchangeRateServiceOptions = {}) {
    super({
      apiKey: process.env.EXCHANGE_RATE_API_KEY ?? env.EXCHANGE_RATE_API_KEY,
      dbClient: options.dbClient ?? db,
      fetchImpl: options.fetchImpl,
      logger: options.logger ?? exchangeRateLogger,
    });
  }
}
