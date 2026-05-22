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
  SortOrderSchema,
  UuidSchema,
} from "../../lib/schemas.js";
import {
  BankAccountInactiveError,
  BankAccountNotFoundError,
  createFund,
  deleteFund,
  FUND_SORT_FIELDS,
  FundConflictError,
  FundCurrencyChangedError,
  getFund,
  listFunds,
  updateFund,
} from "./service.js";

const FundTypeSchema = Type.Union(FUND_TYPE_VALUES.map((value) => Type.Literal(value)));

const FundCreateBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 255 }),
  description: Type.Optional(Type.Union([Type.String({ maxLength: 5000 }), Type.Null()])),
  type: Type.Optional(FundTypeSchema),
  bankAccountId: Type.Optional(Type.String({ format: "uuid" })),
});

const FundUpdateBody = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    description: Type.Optional(Type.Union([Type.String({ maxLength: 5000 }), Type.Null()])),
    type: Type.Optional(FundTypeSchema),
    bankAccountId: Type.Optional(Type.String({ format: "uuid" })),
  },
  { minProperties: 1 },
);

const FundResponse = Type.Object({
  id: UuidSchema,
  orgId: UuidSchema,
  name: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  type: FundTypeSchema,
  bankAccountId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  settlementCurrency: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

/**
 * Server-side sort fields whitelist for `GET /funds`. Single source
 * of truth lives in `./service.ts` (issue #218).
 */
const FundSortFieldSchema = Type.Union(FUND_SORT_FIELDS.map((field) => Type.Literal(field)));

const FundListQuery = Type.Intersect([
  PaginationQuery,
  Type.Object({
    sort: Type.Optional(FundSortFieldSchema),
    order: Type.Optional(SortOrderSchema),
  }),
]);

export async function fundRoutes(app: FastifyInstance) {
  app.get(
    "/funds",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Funds"],
        querystring: FundListQuery,
        response: { 200: DataArrayResponse(FundResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const query = request.query as {
        page?: number;
        perPage?: number;
        sort?: (typeof FUND_SORT_FIELDS)[number];
        order?: "asc" | "desc";
      };
      const result = await listFunds(orgId, {
        page: query.page ?? 1,
        perPage: query.perPage ?? 20,
        sort: query.sort,
        order: query.order,
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
        bankAccountId?: string;
      };

      try {
        const fund = await createFund(orgId, body);
        return reply.status(201).send({ data: fund });
      } catch (error) {
        if (error instanceof BankAccountNotFoundError) {
          return reply.status(404).send({
            type: "urn:givernance:error:not-found",
            title: "Not Found",
            status: 404,
            detail: error.message,
            instance: request.url,
          });
        }
        if (error instanceof BankAccountInactiveError) {
          return reply.status(422).send({
            type: "urn:givernance:error:validation",
            title: "Unprocessable Entity",
            status: 422,
            detail: error.message,
            instance: request.url,
          });
        }
        throw error;
      }
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
        bankAccountId?: string;
      };

      try {
        const updated = await updateFund(orgId, id, body);

        if (!updated) {
          return reply.status(404).send(problemDetail(404, "Not Found", "Fund not found"));
        }

        return { data: updated };
      } catch (error) {
        if (error instanceof BankAccountNotFoundError) {
          return reply.status(404).send({
            type: "urn:givernance:error:not-found",
            title: "Not Found",
            status: 404,
            detail: error.message,
            instance: request.url,
          });
        }
        if (error instanceof BankAccountInactiveError) {
          return reply.status(422).send({
            type: "urn:givernance:error:validation",
            title: "Unprocessable Entity",
            status: 422,
            detail: error.message,
            instance: request.url,
          });
        }
        if (error instanceof FundCurrencyChangedError) {
          return reply.status(422).send({
            type: "urn:givernance:error:validation",
            title: "Unprocessable Entity",
            status: 422,
            detail: error.message,
            instance: request.url,
          });
        }
        throw error;
      }
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
