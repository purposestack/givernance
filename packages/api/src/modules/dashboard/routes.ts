/** Dashboard routes — month-over-month KPI aggregates for the home screen */

import { FEATURE_FLAG_KEYS, FxRateService } from "@givernance/shared";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { env } from "../../env.js";
import { requireAuth } from "../../lib/guards.js";
import { redis } from "../../lib/redis.js";
import { DataResponse, ErrorResponses, problemDetail } from "../../lib/schemas.js";
import { getDashboardStats, getMultiCurrencyTotal } from "./service.js";

const PeriodSchema = Type.Object({
  current: Type.Integer({ minimum: 0 }),
  previous: Type.Integer({ minimum: 0 }),
});

const MultiCurrencyTotalSchema = Type.Object({
  totalDisplayCents: Type.Integer({ minimum: 0 }),
  displayCurrency: Type.String(),
  exchangeRateTimestamp: Type.Union([Type.String(), Type.Null()]),
});

const DashboardStatsSchema = Type.Object({
  totalRaisedCents: PeriodSchema,
  newDonors: PeriodSchema,
  newActiveCampaigns: PeriodSchema,
  multiCurrencyTotal: Type.Optional(MultiCurrencyTotalSchema),
});

/** Shared FxRateService instance — reads from Redis cache populated by worker. */
const fxService = new FxRateService({ redis, apiKey: env.FIXER_API_KEY });

export async function dashboardRoutes(app: FastifyInstance) {
  app.get(
    "/dashboard/stats",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Dashboard"],
        response: {
          200: DataResponse(DashboardStatsSchema),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const flagEnabled = await request.flagService.isEnabled(
        FEATURE_FLAG_KEYS.DONATION_MULTI_CURRENCY,
        { orgId },
      );

      const [stats, multiCurrencyTotal] = await Promise.all([
        getDashboardStats(orgId),
        flagEnabled ? getMultiCurrencyTotal(orgId, fxService) : Promise.resolve(null),
      ]);

      const data =
        flagEnabled && multiCurrencyTotal !== null ? { ...stats, multiCurrencyTotal } : stats;

      return { data };
    },
  );
}
