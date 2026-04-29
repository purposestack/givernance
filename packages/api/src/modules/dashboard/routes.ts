/** Dashboard routes — month-over-month KPI aggregates for the home screen */

import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../../lib/guards.js";
import { DataResponse, ErrorResponses, problemDetail } from "../../lib/schemas.js";
import { getDashboardStats } from "./service.js";

const PeriodSchema = Type.Object({
  current: Type.Integer({ minimum: 0 }),
  previous: Type.Integer({ minimum: 0 }),
});

const DashboardStatsSchema = Type.Object({
  totalRaisedCents: PeriodSchema,
  newDonors: PeriodSchema,
  newActiveCampaigns: PeriodSchema,
});

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
      const data = await getDashboardStats(orgId);
      return { data };
    },
  );
}
