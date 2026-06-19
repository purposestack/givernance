/**
 * FxRateService factory — pre-binds the worker's infra (issue #480).
 *
 * The single implementation lives in `@givernance/shared/finance` (infra-
 * agnostic, DI-only — it takes an injected redis client + API key). This thin
 * factory pre-binds the worker-local shared ioredis connection and
 * `FIXER_API_KEY`, and adapts a pino logger to the shared `{ warn, info }`
 * shape so processors construct it without repeating the wiring. The API has a
 * symmetric factory (`packages/api/src/lib/fx-rate-service.ts`), so both
 * packages drive ONE Fixer.io lookup implementation.
 */

import { FxRateService } from "@givernance/shared/finance";
import type { Logger } from "pino";
import { env } from "../env.js";
import { redis } from "./redis.js";

/**
 * Build an FxRateService bound to the worker's Redis + FIXER_API_KEY.
 *
 * Pass the job's pino child logger to route FX-cache warnings/info through the
 * structured worker log; omit it to fall back to the shared service's console.
 */
export function makeFxRateService(log?: Pick<Logger, "warn" | "info">): FxRateService {
  return new FxRateService({
    apiKey: env.FIXER_API_KEY,
    redis,
    logger: log
      ? {
          warn: (obj: unknown, msg?: unknown) => log.warn(obj as object, String(msg ?? "")),
          info: (obj: unknown, msg?: unknown) => log.info(obj as object, String(msg ?? "")),
        }
      : undefined,
  });
}
