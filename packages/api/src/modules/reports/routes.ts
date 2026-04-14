/** Report routes — donor lifecycle analytics (LYBUNT/SYBUNT) */

import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../../lib/guards.js";
import {
  DataArrayResponseNoPagination,
  ErrorResponses,
  problemDetail,
  UuidSchema,
} from "../../lib/schemas.js";
import { getLybuntReport, getSybuntReport } from "./service.js";

const LifecycleConstituentResponse = Type.Object({
  id: UuidSchema,
  firstName: Type.String(),
  lastName: Type.String(),
  email: Type.Union([Type.String(), Type.Null()]),
  lastDonationAt: Type.String(),
  totalDonatedCents: Type.Integer(),
});

const ReportQuery = Type.Object({
  year: Type.Optional(Type.Integer({ minimum: 2000, maximum: 2100 })),
});

export async function reportsRoutes(app: FastifyInstance) {
  /** LYBUNT — constituents who donated last year but not this year */
  app.get(
    "/reports/lybunt",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Reports"],
        querystring: ReportQuery,
        response: {
          200: DataArrayResponseNoPagination(LifecycleConstituentResponse),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const query = request.query as { year?: number };
      const data = await getLybuntReport(orgId, query.year);
      return { data };
    },
  );

  /** SYBUNT — constituents who donated in some past year but not this year */
  app.get(
    "/reports/sybunt",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Reports"],
        querystring: ReportQuery,
        response: {
          200: DataArrayResponseNoPagination(LifecycleConstituentResponse),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const query = request.query as { year?: number };
      const data = await getSybuntReport(orgId, query.year);
      return { data };
    },
  );
}
