/** Fund routes — tenant-scoped CRUD for restricted and unrestricted funds */

import { FUND_TYPE_VALUES } from "@givernance/shared/schema";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { requireAuth, requireOrgAdmin } from "../../lib/guards.js";
import {
  DataArrayResponse,
  DataResponse,
  ErrorResponses,
  IdParams,
  PaginationQuery,
  ProblemDetailSchema,
  problemDetail,
  UuidSchema,
} from "../../lib/schemas.js";
import {
  createFund,
  deleteFund,
  FundConflictError,
  getFund,
  listFunds,
  updateFund,
} from "./service.js";

const FundTypeSchema = Type.Union(FUND_TYPE_VALUES.map((value) => Type.Literal(value)));

const FundCreateBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 255 }),
  description: Type.Optional(Type.Union([Type.String({ maxLength: 5000 }), Type.Null()])),
  type: Type.Optional(FundTypeSchema),
});

const FundUpdateBody = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    description: Type.Optional(Type.Union([Type.String({ maxLength: 5000 }), Type.Null()])),
    type: Type.Optional(FundTypeSchema),
  },
  { minProperties: 1 },
);

const FundResponse = Type.Object({
  id: UuidSchema,
  orgId: UuidSchema,
  name: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  type: FundTypeSchema,
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

export async function fundRoutes(app: FastifyInstance) {
  app.get(
    "/funds",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Funds"],
        querystring: PaginationQuery,
        response: { 200: DataArrayResponse(FundResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const query = request.query as { page?: number; perPage?: number };
      const result = await listFunds(orgId, {
        page: query.page ?? 1,
        perPage: query.perPage ?? 20,
      });

      return { data: result.data, pagination: result.pagination };
    },
  );

  app.post(
    "/funds",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Funds"],
        body: FundCreateBody,
        response: {
          201: DataResponse(FundResponse),
          400: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const body = request.body as {
        name: string;
        description?: string | null;
        type?: "restricted" | "unrestricted";
      };

      const fund = await createFund(orgId, body);
      return reply.status(201).send({ data: fund });
    },
  );

  app.get(
    "/funds/:id",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Funds"],
        params: IdParams,
        response: { 200: DataResponse(FundResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const { id } = request.params as { id: string };
      const fund = await getFund(orgId, id);

      if (!fund) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Fund not found"));
      }

      return { data: fund };
    },
  );

  app.patch(
    "/funds/:id",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Funds"],
        params: IdParams,
        body: FundUpdateBody,
        response: {
          200: DataResponse(FundResponse),
          400: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const { id } = request.params as { id: string };
      const body = request.body as {
        name?: string;
        description?: string | null;
        type?: "restricted" | "unrestricted";
      };

      const updated = await updateFund(orgId, id, body);

      if (!updated) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Fund not found"));
      }

      return { data: updated };
    },
  );

  app.delete(
    "/funds/:id",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Funds"],
        params: IdParams,
        response: {
          200: DataResponse(FundResponse),
          409: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const { id } = request.params as { id: string };

      try {
        const deleted = await deleteFund(orgId, id);

        if (!deleted) {
          return reply.status(404).send(problemDetail(404, "Not Found", "Fund not found"));
        }

        return { data: deleted };
      } catch (error) {
        if (error instanceof FundConflictError) {
          return reply.status(409).send(problemDetail(409, "Conflict", error.message));
        }
        throw error;
      }
    },
  );
}
