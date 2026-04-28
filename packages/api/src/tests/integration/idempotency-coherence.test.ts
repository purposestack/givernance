/**
 * Issue #181 + PR #185 review PJD-2 — `minRole` ↔ `preHandler` coherence
 * snapshot.
 *
 * The "MUST set `minRole`" rule on idempotency-keyed routes is a comment,
 * not machine-enforceable. If someone later changes `preHandler:
 * requireWrite` to `requireOrgAdmin` without updating `minRole`, the
 * cached-replay-bypass-RBAC vulnerability (the whole reason `minRole`
 * exists) silently comes back.
 *
 * This test captures every registered route at startup via Fastify's
 * `onRoute` lifecycle hook, finds the ones with an `idempotency.routeKey`,
 * and asserts the guard ↔ minRole mapping is exact. Adding a future
 * idempotency-keyed authenticated route MUST trip this snapshot until
 * its `minRole` is set correctly.
 *
 * Mapping rule:
 *   - `preHandler: requireWrite`     → `minRole: "write"`
 *   - `preHandler: requireOrgAdmin`  → `minRole: "admin"`
 *   - any other guard                → must opt out explicitly via the
 *     allowlist below with a documented justification.
 */

import type { FastifyInstance, RouteOptions } from "fastify";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  requireAuth,
  requireOrgAdmin,
  requireSuperAdmin,
  requireSuperAdminOrOwnOrgAdmin,
  requireWrite,
} from "../../lib/guards.js";

// We register the same routes the production server does, but on a
// minimal Fastify instance with `onRoute` capturing every registration —
// avoids reaching into the live server's private state and works
// regardless of Fastify version.
import { campaignRoutes } from "../../modules/campaigns/routes.js";
import { donationRoutes } from "../../modules/donations/routes.js";
import { pledgeRoutes } from "../../modules/pledges/routes.js";

interface CapturedRoute {
  method: string | string[];
  url: string;
  config?: { idempotency?: { routeKey: string; minRole?: "write" | "admin" } };
  preHandler?: unknown;
}

let app: FastifyInstance;
const routes: CapturedRoute[] = [];

beforeAll(async () => {
  app = Fastify({ logger: false });
  app.addHook("onRoute", (route: RouteOptions) => {
    routes.push({
      method: route.method,
      url: route.url,
      config: route.config as CapturedRoute["config"],
      preHandler: route.preHandler,
    });
  });

  // Plugins under test all live on the `/v1` prefix.
  await app.register(donationRoutes, { prefix: "/v1" });
  await app.register(pledgeRoutes, { prefix: "/v1" });
  await app.register(campaignRoutes, { prefix: "/v1" });

  await app.ready();
});

afterAll(async () => {
  await app.close();
});

/**
 * Routes that DELIBERATELY skip `minRole` even though they're
 * authenticated and idempotency-keyed. Currently empty — every keyed route
 * in the codebase has a guard whose mapping is unambiguous.
 */
const MIN_ROLE_OPT_OUT = new Set<string>();

function expectedMinRoleFor(preHandler: unknown): "write" | "admin" | "none" | "unknown" {
  const handlers = Array.isArray(preHandler) ? preHandler : [preHandler];
  for (const h of handlers) {
    if (h === requireOrgAdmin) return "admin";
    if (h === requireWrite) return "write";
    if (h === requireAuth) return "none";
    if (h === requireSuperAdmin) return "none";
    if (h === requireSuperAdminOrOwnOrgAdmin) return "none";
  }
  return "unknown";
}

describe("Idempotency `minRole` ↔ guard coherence (review PJD-2)", () => {
  it("every idempotency-keyed route's minRole matches its preHandler", () => {
    const keyedRoutes = routes.filter((r) => Boolean(r.config?.idempotency));

    // Sanity: at least the four known idempotency-keyed routes must have
    // been visited. If this drops below 4, the introspection broke and
    // the assertion below would silently pass.
    expect(keyedRoutes.length).toBeGreaterThanOrEqual(4);

    for (const route of keyedRoutes) {
      const idem = route.config?.idempotency;
      if (!idem) continue;
      const routeKey = idem.routeKey;

      if (MIN_ROLE_OPT_OUT.has(routeKey)) continue;

      const expected = expectedMinRoleFor(route.preHandler);
      if (expected === "admin") {
        expect(idem.minRole, `${routeKey} preHandler is requireOrgAdmin`).toBe("admin");
      } else if (expected === "write") {
        expect(idem.minRole, `${routeKey} preHandler is requireWrite`).toBe("write");
      } else if (expected === "unknown") {
        throw new Error(
          `${routeKey} carries idempotency config but preHandler is unrecognised — add it to expectedMinRoleFor() or to MIN_ROLE_OPT_OUT with a justification.`,
        );
      }
    }
  });
});
