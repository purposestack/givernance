/**
 * `requireFlag(key)` — Fastify preHandler that gates a route on a
 * feature flag. Disabled = 404, NOT 403:
 *
 *   - 404 doesn't disclose feature existence to an unauthorised
 *     scanner. The gated route should look indistinguishable from
 *     a typo'd URL.
 *   - The web layer's `notFound()` server-component pattern aligns:
 *     a flag-off route returns 404 in both layers.
 *
 * The guard reads from the shared `flagService` (which itself reads
 * Redis → PG on miss). Evaluation is async but cached, so the worst
 * case is one PG query per minute per replica.
 *
 * Doc 18 §6.1 specifies this pattern; bulk-email (issue #326 / PR #352)
 * is the first consumer.
 */

import type { FeatureFlagKey } from "@givernance/shared/constants";
import type { FastifyReply, FastifyRequest } from "fastify";
import { problemDetail } from "../schemas.js";
import { flagService as defaultFlagService, type FlagService } from "./flag-service.js";

/**
 * Build a `preHandler` that 404s the route when `flagKey` is off.
 *
 * The injected `service` is the per-request `request.flagService` when
 * the flag plugin is registered (see `flag-plugin.ts`), or the module
 * singleton otherwise. Tests can pass a stub directly.
 */
export function requireFlag(flagKey: FeatureFlagKey, service: FlagService = defaultFlagService) {
  return async function flagPreHandler(request: FastifyRequest, reply: FastifyReply) {
    const effective: FlagService = request.flagService ?? service;
    const enabled = await effective.isEnabled(flagKey);
    if (!enabled) {
      // Structured log so SRE can see how often a gated route is hit
      // while disabled — useful signal that a feature is in demand
      // OR that an unauthorised scanner is poking around.
      request.log.info(
        { event: "flag.route_gated", flagKey, path: request.url, method: request.method },
        "Route gated off — feature flag disabled",
      );
      return reply.status(404).send(problemDetail(404, "Not Found", "Route not found"));
    }
  };
}
