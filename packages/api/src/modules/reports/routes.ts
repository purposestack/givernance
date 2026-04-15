/** Report routes — donor lifecycle analytics (LYBUNT/SYBUNT) */

import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { requireOrgAdmin } from "../../lib/guards.js";
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
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 100 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
});

export async function reportsRoutes(app: FastifyInstance) {
  /** LYBUNT — constituents who donated last year but not this year */
  app.get(
    "/reports/lybunt",
    {
      preHandler: requireOrgAdmin,
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

      const query = request.query as { year?: number; limit?: number; offset?: number };
      const data = await getLybuntReport(orgId, query.year, {
        limit: query.limit ?? 100,
        offset: query.offset ?? 0,
      });
      return { data };
    },
  );

  /** SYBUNT — constituents who donated in some past year but not this year */
  app.get(
    "/reports/sybunt",
    {
      preHandler: requireOrgAdmin,
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

      const query = request.query as { year?: number; limit?: number; offset?: number };
      const data = await getSybuntReport(orgId, query.year, {
        limit: query.limit ?? 100,
        offset: query.offset ?? 0,
      });
      return { data };
    },
  );
}
