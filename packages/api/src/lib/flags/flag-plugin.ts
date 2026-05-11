/**
 * Fastify plugin — decorates every request with a `flagService` so
 * route handlers + sub-services don't have to import the module
 * singleton directly. Aligns with how the rest of the codebase
 * threads cross-cutting deps (audit, idempotency, redis).
 *
 * Tests can override the decorator before the route fires:
 *
 *   app.addHook("onRequest", (req, _reply, done) => {
 *     req.flagService = stubFlagService;
 *     done();
 *   });
 */

import fp from "fastify-plugin";
import { type FlagService, flagService } from "./flag-service.js";

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Per-request feature-flag evaluator. Backed by the shared
     * `flagService` (Redis-cached + PG-sourced). Decorated by
     * `flagPlugin`; never undefined in registered routes.
     */
    flagService: FlagService;
  }
}

export const flagPlugin = fp(async (app) => {
  app.decorateRequest("flagService", null as unknown as FlagService);
  app.addHook("onRequest", async (request) => {
    request.flagService = flagService;
  });
});
