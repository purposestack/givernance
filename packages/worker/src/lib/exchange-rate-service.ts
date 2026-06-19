/**
 * ExchangeRateService adapter — pre-binds the worker's infra (issue #480).
 *
 * The single implementation lives in `@givernance/shared/finance` (infra-
 * agnostic, DI-only). This thin subclass pre-binds the worker-local
 * `EXCHANGE_RATE_API_KEY`, the owner-pool `db`, and the worker logger so
 * processors construct it without repeating the wiring — mirroring the API's
 * `modules/finance/exchange-rate-service.ts` adapter so the two packages drive
 * ONE conversion implementation with infra ownership staying in each process.
 *
 * Pass a per-call `dbClient` (e.g. the active `withWorkerContext` transaction)
 * to scope the org-base-currency lookup to that tenant; it defaults to the
 * worker's owner-pool `db` when omitted.
 */

import { ExchangeRateService as SharedExchangeRateService } from "@givernance/shared/finance";
import { env } from "../env.js";
import { db } from "./db.js";
import { logger } from "./logger.js";

interface WorkerExchangeRateServiceOptions {
  dbClient?: Pick<typeof db, "select" | "insert">;
  fetchImpl?: typeof fetch;
  logger?: { warn: (...args: unknown[]) => void };
}

export class ExchangeRateService extends SharedExchangeRateService {
  constructor(options: WorkerExchangeRateServiceOptions = {}) {
    super({
      apiKey: env.EXCHANGE_RATE_API_KEY,
      dbClient: options.dbClient ?? db,
      fetchImpl: options.fetchImpl,
      logger: options.logger ?? logger,
    });
  }
}
