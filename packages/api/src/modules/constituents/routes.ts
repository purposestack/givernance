/** Constituent routes — full CRUD with search, filtering, and soft-delete */

import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { requireAuth, requireOrgAdmin } from "../../lib/guards.js";
import {
  createConstituent,
  deleteConstituent,
  findDuplicates,
  getConstituent,
  listConstituents,
  mergeConstituents,
  updateConstituent,
} from "./service.js";

const ConstituentCreateBody = Type.Object({
  firstName: Type.String({ minLength: 1, maxLength: 255 }),
  lastName: Type.String({ minLength: 1, maxLength: 255 }),
  email: Type.Optional(Type.String({ maxLength: 255 })),
  phone: Type.Optional(Type.String({ maxLength: 50 })),
  type: Type.Optional(
    Type.Union([
      Type.Literal("donor"),
      Type.Literal("volunteer"),
      Type.Literal("member"),
      Type.Literal("beneficiary"),
      Type.Literal("partner"),
    ]),
  ),
  tags: Type.Optional(Type.Array(Type.String())),
});

const ConstituentUpdateBody = Type.Partial(ConstituentCreateBody);

const IdParams = Type.Object({
  id: Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" }),
});

const ListQuery = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  perPage: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  search: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Union([Type.Array(Type.String()), Type.String()])),
  type: Type.Optional(
    Type.Union([
      Type.Literal("donor"),
      Type.Literal("volunteer"),
      Type.Literal("member"),
      Type.Literal("beneficiary"),
      Type.Literal("partner"),
    ]),
  ),
  includeDeleted: Type.Optional(Type.Boolean({ default: false })),
});

const DuplicateSearchQuery = Type.Object({
  firstName: Type.String({ minLength: 1, maxLength: 255 }),
  lastName: Type.String({ minLength: 1, maxLength: 255 }),
  email: Type.Optional(Type.String({ maxLength: 255 })),
});

const CreateQuery = Type.Object({
  force: Type.Optional(Type.Boolean({ default: false })),
});

const MergeBody = Type.Object({
  targetId: Type.String({
    pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
  }),
});

export async function constituentRoutes(app: FastifyInstance) {
  /** List constituents with pagination, search, and filtering */
  app.get(
    "/constituents",
    { preHandler: requireAuth, schema: { querystring: ListQuery } },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply
          .status(401)
          .send({ statusCode: 401, error: "Unauthorized", message: "Missing auth context" });
      }

      const query = request.query as {
        page?: number;
        perPage?: number;
        search?: string;
        tags?: string[] | string;
        type?: string;
        includeDeleted?: boolean;
      };

      const tags = query.tags ? (Array.isArray(query.tags) ? query.tags : [query.tags]) : undefined;

      const result = await listConstituents(orgId, {
        page: query.page ?? 1,
        perPage: query.perPage ?? 20,
        search: query.search,
        tags,
        type: query.type,
        includeDeleted: query.includeDeleted,
      });

      return { data: result.data, pagination: result.pagination };
    },
  );

  /** Get a single constituent by ID */
  app.get(
    "/constituents/:id",
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply
          .status(401)
          .send({ statusCode: 401, error: "Unauthorized", message: "Missing auth context" });
      }

      const { id } = request.params as { id: string };
      const constituent = await getConstituent(orgId, id);

      if (!constituent) {
        return reply.status(404).send({
          type: "https://httpproblems.com/http-status/404",
          title: "Not Found",
          status: 404,
          detail: "Constituent not found",
        });
      }

      return { data: constituent };
    },
  );

  /** Search for potential duplicate constituents */
  app.get(
    "/constituents/duplicates/search",
    { preHandler: requireAuth, schema: { querystring: DuplicateSearchQuery } },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply
          .status(401)
          .send({ statusCode: 401, error: "Unauthorized", message: "Missing auth context" });
      }

      const query = request.query as { firstName: string; lastName: string; email?: string };
      const duplicates = await findDuplicates(orgId, query);
      return { data: duplicates };
    },
  );

  /** Create a new constituent (with duplicate pre-check unless force=true) */
  app.post(
    "/constituents",
    { preHandler: requireAuth, schema: { body: ConstituentCreateBody, querystring: CreateQuery } },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply
          .status(401)
          .send({ statusCode: 401, error: "Unauthorized", message: "Missing auth context" });
      }

      const body = request.body as {
        firstName: string;
        lastName: string;
        email?: string;
        phone?: string;
        type?: string;
        tags?: string[];
      };
      const query = request.query as { force?: boolean };

      if (!query.force) {
        const duplicates = await findDuplicates(orgId, {
          firstName: body.firstName,
          lastName: body.lastName,
          email: body.email,
        });
        if (duplicates.length > 0) {
          return reply.status(409).send({
            type: "https://httpproblems.com/http-status/409",
            title: "Conflict",
            status: 409,
            detail: "Potential duplicate constituents found",
            duplicates,
          });
        }
      }

      const constituent = await createConstituent(orgId, body);
      return reply.status(201).send({ data: constituent });
    },
  );

  /** Update a constituent (partial update) */
  app.put(
    "/constituents/:id",
    { preHandler: requireAuth, schema: { params: IdParams, body: ConstituentUpdateBody } },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      const userId = request.auth?.userId;
      if (!orgId || !userId) {
        return reply
          .status(401)
          .send({ statusCode: 401, error: "Unauthorized", message: "Missing auth context" });
      }

      const { id } = request.params as { id: string };
      const body = request.body as {
        firstName?: string;
        lastName?: string;
        email?: string;
        phone?: string;
        type?: string;
        tags?: string[];
      };

      const updated = await updateConstituent(orgId, id, body, userId);

      if (!updated) {
        return reply.status(404).send({
          type: "https://httpproblems.com/http-status/404",
          title: "Not Found",
          status: 404,
          detail: "Constituent not found",
        });
      }

      return { data: updated };
    },
  );

  /** Soft-delete a constituent */
  app.delete(
    "/constituents/:id",
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      const userId = request.auth?.userId;
      if (!orgId || !userId) {
        return reply
          .status(401)
          .send({ statusCode: 401, error: "Unauthorized", message: "Missing auth context" });
      }

      const { id } = request.params as { id: string };
      const deleted = await deleteConstituent(orgId, id, userId);

      if (!deleted) {
        return reply.status(404).send({
          type: "https://httpproblems.com/http-status/404",
          title: "Not Found",
          status: 404,
          detail: "Constituent not found",
        });
      }

      return { data: deleted };
    },
  );

  /** Merge a duplicate constituent into a primary constituent */
  app.post(
    "/constituents/:id/merge",
    { preHandler: requireOrgAdmin, schema: { params: IdParams, body: MergeBody } },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      const userId = request.auth?.userId;
      if (!orgId || !userId) {
        return reply
          .status(401)
          .send({ statusCode: 401, error: "Unauthorized", message: "Missing auth context" });
      }

      const { id } = request.params as { id: string };
      const { targetId } = request.body as { targetId: string };

      if (id === targetId) {
        return reply.status(400).send({
          type: "https://httpproblems.com/http-status/400",
          title: "Bad Request",
          status: 400,
          detail: "Cannot merge a constituent into itself",
        });
      }

      const result = await mergeConstituents(orgId, id, targetId, userId);

      if (!result) {
        return reply.status(404).send({
          type: "https://httpproblems.com/http-status/404",
          title: "Not Found",
          status: 404,
          detail: "One or both constituents not found",
        });
      }

      return { data: result };
    },
  );
}
