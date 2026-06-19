/**
 * FxRateService factory — pre-binds the API's infra (issue #480).
 *
 * The single implementation lives in `@givernance/shared/finance` (infra-
 * agnostic, DI-only — it takes an injected redis client + API key). This thin
 * factory pre-binds the API's shared ioredis connection and `FIXER_API_KEY` so
 * route handlers construct it without repeating the wiring. The worker has a
 * symmetric factory (`packages/worker/src/lib/fx-rate-service.ts`), so both
 * packages drive ONE Fixer.io lookup implementation.
 */

import { FxRateService } from "@givernance/shared/finance";
import { env } from "../env.js";
import { redis } from "./redis.js";

/** Build an FxRateService bound to the API's Redis + FIXER_API_KEY. */
export function makeFxRateService(): FxRateService {
  return new FxRateService({ apiKey: env.FIXER_API_KEY, redis });
}
