/** Constituent routes — full CRUD with search, filtering, and soft-delete */

import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { requireAuth, requireOrgAdmin } from "../../lib/guards.js";
import {
  DataArrayResponse,
  DataArrayResponseNoPagination,
  DataResponse,
  ErrorResponses,
  IdParams,
  PaginationQuery,
  ProblemDetailSchema,
  problemDetail,
  UuidSchema,
} from "../../lib/schemas.js";
import {
  createConstituent,
  deleteConstituent,
  findDuplicates,
  getConstituent,
  listConstituents,
  MergePreconditionError,
  mergeConstituents,
  updateConstituent,
} from "./service.js";

const ConstituentTypeEnum = Type.Union([
  Type.Literal("donor"),
  Type.Literal("volunteer"),
  Type.Literal("member"),
  Type.Literal("beneficiary"),
  Type.Literal("partner"),
]);

const ConstituentCreateBody = Type.Object({
  firstName: Type.String({ minLength: 1, maxLength: 255 }),
  lastName: Type.String({ minLength: 1, maxLength: 255 }),
  email: Type.Optional(Type.String({ maxLength: 255 })),
  phone: Type.Optional(Type.String({ maxLength: 50 })),
  type: Type.Optional(ConstituentTypeEnum),
  tags: Type.Optional(Type.Array(Type.String())),
});

// Per the convention in @givernance/shared validators: optional fields accept
// `null` on UPDATE to mean "clear this field to NULL in the DB" (vs omitted =
// "leave alone"). Without this distinction the form has no way to express
// "remove the phone number from this constituent" — the client drops empty
// fields to avoid clobbering, and the API never sees them.
//
// Null variants come FIRST in every nullable Union — Fastify's ajv has
// `coerceTypes: true` by default and will silently coerce a runtime `null`
// to `""` if the first schema in the Union is `Type.String()`. With Null
// first, ajv recognises the value as already-valid and leaves it alone.
const ConstituentUpdateBody = Type.Object(
  {
    firstName: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    lastName: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    email: Type.Optional(Type.Union([Type.Null(), Type.String({ maxLength: 255 })])),
    phone: Type.Optional(Type.Union([Type.Null(), Type.String({ maxLength: 50 })])),
    type: Type.Optional(ConstituentTypeEnum),
    tags: Type.Optional(Type.Array(Type.String())),
  },
  { minProperties: 1 },
);

const ListQuery = Type.Intersect([
  PaginationQuery,
  Type.Object({
    search: Type.Optional(Type.String()),
    tags: Type.Optional(Type.Union([Type.Array(Type.String()), Type.String()])),
    type: Type.Optional(ConstituentTypeEnum),
    includeDeleted: Type.Optional(Type.Boolean({ default: false })),
  }),
]);

const DuplicateSearchQuery = Type.Object({
  firstName: Type.String({ minLength: 1, maxLength: 255 }),
  lastName: Type.String({ minLength: 1, maxLength: 255 }),
  email: Type.Optional(Type.String({ maxLength: 255 })),
});

const CreateQuery = Type.Object({
  force: Type.Optional(Type.Boolean({ default: false })),
});

const MergeBody = Type.Object({
  targetId: UuidSchema,
});

/**
 * Constituent shape returned by the API.
 *
 * Null variants come FIRST in every nullable Union — fast-json-stringify
 * (Fastify's response serializer) walks `oneOf` in declaration order and
 * coerces values to the first compatible schema. With `Type.String()` first,
 * a runtime `null` from a NULL DB column would be coerced to `""` in the
 * JSON output, breaking nullable semantics for clients (the constituent
 * edit form's "clear phone" path returns null from the service but the
 * client sees an empty string in the response).
 */
const ConstituentResponse = Type.Object({
  id: UuidSchema,
  orgId: UuidSchema,
  firstName: Type.String(),
  lastName: Type.String(),
  email: Type.Union([Type.Null(), Type.String()]),
  phone: Type.Union([Type.Null(), Type.String()]),
  type: Type.String(),
  tags: Type.Union([Type.Null(), Type.Array(Type.String())]),
  deletedAt: Type.Union([Type.Null(), Type.String()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  activities: Type.Optional(Type.Array(Type.Unknown())),
});

const DuplicateResponse = Type.Object({
  id: UuidSchema,
  firstName: Type.String(),
  lastName: Type.String(),
  email: Type.Union([Type.String(), Type.Null()]),
  score: Type.Number(),
});

const ConflictResponse = Type.Intersect([
  ProblemDetailSchema,
  Type.Object({ duplicates: Type.Array(DuplicateResponse) }),
]);

const MergeResult = Type.Object({ merged: Type.Boolean(), etag: Type.String() });

const MergeHeaders = Type.Object({
  "if-match": Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
});

export async function constituentRoutes(app: FastifyInstance) {
  /** List constituents with pagination, search, and filtering */
  app.get(
    "/constituents",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Constituents"],
        querystring: ListQuery,
        response: { 200: DataArrayResponse(ConstituentResponse), ...ErrorResponses },
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
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Constituents"],
        params: IdParams,
        response: { 200: DataResponse(ConstituentResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const { id } = request.params as { id: string };
      const constituent = await getConstituent(orgId, id);

      if (!constituent) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Constituent not found"));
      }

      return { data: constituent };
    },
  );

  /** Search for potential duplicate constituents */
  app.get(
    "/constituents/duplicates/search",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Constituents"],
        querystring: DuplicateSearchQuery,
        response: {
          200: DataArrayResponseNoPagination(DuplicateResponse),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const query = request.query as { firstName: string; lastName: string; email?: string };
      const duplicates = await findDuplicates(orgId, query);
      return { data: duplicates };
    },
  );

  /** Create a new constituent (with duplicate pre-check unless force=true) */
  app.post(
    "/constituents",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Constituents"],
        body: ConstituentCreateBody,
        querystring: CreateQuery,
        response: {
          201: DataResponse(ConstituentResponse),
          409: ConflictResponse,
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
            ...problemDetail(409, "Conflict", "Potential duplicate constituents found"),
            duplicates,
          });
        }
      }

      const constituent = await createConstituent(orgId, body);
      if (constituent) {
        reply.header("Location", `/v1/constituents/${constituent.id}`);
      }
      return reply.status(201).send({ data: constituent });
    },
  );

  /** Update a constituent (partial update) */
  app.put(
    "/constituents/:id",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Constituents"],
        params: IdParams,
        body: ConstituentUpdateBody,
        response: { 200: DataResponse(ConstituentResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      const userId = request.auth?.userId;
      if (!orgId || !userId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const { id } = request.params as { id: string };
      const body = request.body as {
        firstName?: string;
        lastName?: string;
        email?: string | null;
        phone?: string | null;
        type?: string;
        tags?: string[];
      };

      const updated = await updateConstituent(orgId, id, body, userId);

      if (!updated) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Constituent not found"));
      }

      return { data: updated };
    },
  );

  /** Soft-delete a constituent */
  app.delete(
    "/constituents/:id",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Constituents"],
        params: IdParams,
        response: { 200: DataResponse(ConstituentResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      const userId = request.auth?.userId;
      if (!orgId || !userId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const { id } = request.params as { id: string };
      const deleted = await deleteConstituent(orgId, id, userId);

      if (!deleted) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Constituent not found"));
      }

      return { data: deleted };
    },
  );

  /** Merge a duplicate constituent into a primary constituent */
  app.post(
    "/constituents/:id/merge",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Constituents"],
        params: IdParams,
        body: MergeBody,
        headers: MergeHeaders,
        response: {
          200: DataResponse(MergeResult),
          400: ProblemDetailSchema,
          409: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      const userId = request.auth?.userId;
      if (!orgId || !userId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const { id } = request.params as { id: string };
      const { targetId } = request.body as { targetId: string };
      const ifMatch = (request.headers as Record<string, string | undefined>)["if-match"];

      if (id === targetId) {
        return reply
          .status(400)
          .send(problemDetail(400, "Bad Request", "Cannot merge a constituent into itself"));
      }

      try {
        const result = await mergeConstituents(
          orgId,
          id,
          targetId,
          // Pass both the effective subject and the impersonating actor so the
          // merge_history snapshot records double-attribution (ADR-016 / #24).
          { userId, actorId: request.auth?.act?.sub ?? null },
          { ifMatch },
        );

        if (!result) {
          return reply
            .status(404)
            .send(problemDetail(404, "Not Found", "One or both constituents not found"));
        }

        // RFC 7232: successful conditional mutation returns the new ETag.
        reply.header("ETag", result.etag);
        return { data: result };
      } catch (err) {
        if (err instanceof MergePreconditionError) {
          return reply
            .status(409)
            .send(
              problemDetail(
                409,
                "Conflict",
                "The survivor constituent has been modified since you last read it. Refetch and retry.",
              ),
            );
        }
        throw err;
      }
    },
  );
}
