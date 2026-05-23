/**
 * Global search routes (Epic #364, GLO-001).
 *
 * `GET /v1/search?q=<query>` returns RLS-scoped, grouped hits across
 * constituents, donations, and campaigns. Backs the `Cmd+K` palette in
 * the web app.
 *
 * preHandler order: `requireFlag` is FIRST so a tenant with the flag
 * off gets 404 (indistinguishable from a typo'd URL), then `requireAuth`
 * resolves the JWT. RBAC: every authenticated tenant member can search;
 * RLS in the service layer enforces tenant scope, and viewers see the
 * same set as users / admins (the palette is a navigation aid, not a
 * permissioned data surface).
 *
 * Rate limit: 60 requests/minute/user. The frontend debounces input by
 * 200 ms, so a sustained keystroke burst lands around 5 req/s — the
 * cap absorbs that while leaving headroom for legitimate use without
 * paging on misbehaviour. (Tighter caps risk false-positive 429s on
 * fast typists.)
 */

import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { requireFlag } from "../../lib/flags/flag-guard.js";
import { requireAuth } from "../../lib/guards.js";
import {
  ErrorResponses,
  ProblemDetailSchema,
  problemDetail,
  UuidSchema,
} from "../../lib/schemas.js";
import { MAX_QUERY_LENGTH, search } from "./service.js";

// ─── Schemas ────────────────────────────────────────────────────────────────

const SearchQuerystring = Type.Object({
  q: Type.String({ minLength: 1, maxLength: MAX_QUERY_LENGTH }),
});

const SearchHitSchema = Type.Object({
  type: Type.Union([
    Type.Literal("constituent"),
    Type.Literal("campaign"),
    Type.Literal("donation"),
  ]),
  id: UuidSchema,
  title: Type.String(),
  subtitle: Type.String(),
  href: Type.String(),
});

const SearchResponse = Type.Object({
  data: Type.Object({
    query: Type.String(),
    groups: Type.Object({
      constituents: Type.Array(SearchHitSchema),
      campaigns: Type.Array(SearchHitSchema),
      donations: Type.Array(SearchHitSchema),
    }),
  }),
});

// ─── Routes ─────────────────────────────────────────────────────────────────

export async function searchRoutes(app: FastifyInstance) {
  app.get(
    "/search",
    {
      // Flag-gate FIRST so a disabled tenant looks identical to a typo'd
      // URL (404). Auth runs second. (Doc 18 §6.1, mirrors notifications
      // and bulk-email routes.)
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.PRODUCTIVITY_COMMAND_PALETTE), requireAuth],
      // 60 req/min/user: matches the debounce-friendly cadence the
      // frontend can produce (5 req/s sustained at the upper bound) and
      // is comfortably above any realistic human typing speed. The
      // bulk-import polling endpoint uses the same value.
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      // Quiet the per-keystroke 200s so a sustained typing burst
      // doesn't flood stdout (and Loki) with the raw `q` substring.
      // Errors (4xx / 5xx) still emit at warn+. The flag-gate denial
      // path emits its own structured `flag.route_gated` log line at
      // info via `requireFlag` (kept) — that one is bounded by route
      // template, not the user's query.
      logLevel: "warn",
      schema: {
        tags: ["Search"],
        summary: "Cross-entity global search backing the command palette",
        querystring: SearchQuerystring,
        response: {
          200: SearchResponse,
          400: ProblemDetailSchema,
          ...ErrorResponses,
          429: ProblemDetailSchema,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing tenant context"));
      }

      const { q } = request.query as { q: string };
      const result = await search(orgId, q);
      return { data: result };
    },
  );
}
