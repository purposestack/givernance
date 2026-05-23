/**
 * API routes for advanced constituent filtering
 */

import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { requireFlag } from "../../../lib/flags/flag-guard.js";
import { requireAuth, requireWrite } from "../../../lib/guards.js";
import { DataResponse, ErrorResponses, problemDetail } from "../../../lib/schemas.js";
import { FilterService } from "./filter.service.js";

// Schema definitions
const FilterOperatorSchema = Type.Union([
  Type.Literal("eq"),
  Type.Literal("neq"),
  Type.Literal("gt"),
  Type.Literal("gte"),
  Type.Literal("lt"),
  Type.Literal("lte"),
  Type.Literal("between"),
  Type.Literal("in"),
  Type.Literal("contains"),
  Type.Literal("startsWith"),
  Type.Literal("endsWith"),
  Type.Literal("arrayContains"),
  Type.Literal("arrayOverlaps"),
  Type.Literal("isNull"),
  Type.Literal("isNotNull"),
]);

const LogicalOperatorSchema = Type.Union([Type.Literal("AND"), Type.Literal("OR")]);

const PatternTypeSchema = Type.Union([
  Type.Literal("LYBUNT"),
  Type.Literal("SYBUNT"),
  Type.Literal("RECURRING"),
  Type.Literal("LAPSED"),
  Type.Literal("MAJOR_DONOR"),
]);

const FilterConditionSchema = Type.Recursive(
  (This) =>
    Type.Object({
      field: Type.String(),
      operator: FilterOperatorSchema,
      value: Type.Optional(Type.Any()),
      subConditions: Type.Optional(
        Type.Object({
          operator: LogicalOperatorSchema,
          conditions: Type.Array(This),
          patterns: Type.Optional(Type.Array(PatternTypeSchema)),
        }),
      ),
    }),
  { $id: "FilterCondition" },
);

const FilterQuerySchema = Type.Object({
  operator: LogicalOperatorSchema,
  conditions: Type.Array(FilterConditionSchema),
  patterns: Type.Optional(Type.Array(PatternTypeSchema)),
});

const FilterRequestSchema = Type.Object({
  query: FilterQuerySchema,
  pagination: Type.Optional(
    Type.Object({
      page: Type.Integer({ minimum: 1, default: 1 }),
      perPage: Type.Integer({ minimum: 1, maximum: 100, default: 50 }),
    }),
  ),
  sort: Type.Optional(
    Type.Object({
      field: Type.String(),
      order: Type.Union([Type.Literal("asc"), Type.Literal("desc")]),
    }),
  ),
});

const FilterPreviewRequestSchema = Type.Object({
  query: FilterQuerySchema,
});

const FilterSuggestionsRequestSchema = Type.Object({
  field: Type.String(),
  search: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 10 })),
});

const CampaignFilterRequestSchema = Type.Object({
  query: FilterQuerySchema,
});

// Response schemas
const FilterResultSchema = Type.Object({
  data: Type.Array(
    Type.Object({
      id: Type.String(),
      firstName: Type.String(),
      lastName: Type.String(),
      email: Type.Optional(Type.String()),
      phone: Type.Optional(Type.String()),
      type: Type.String(),
      tags: Type.Optional(Type.Array(Type.String())),
      createdAt: Type.String(),
      updatedAt: Type.String(),
      // Aggregated fields
      donationCount: Type.Optional(Type.Integer()),
      totalAmountCents: Type.Optional(Type.Integer()),
      lastDonationDate: Type.Optional(Type.String()),
      patterns: Type.Optional(Type.Array(PatternTypeSchema)),
    }),
  ),
  pagination: Type.Object({
    page: Type.Integer(),
    perPage: Type.Integer(),
    total: Type.Integer(),
    totalPages: Type.Integer(),
  }),
});

const FilterPreviewResultSchema = Type.Object({
  count: Type.Integer(),
  estimatedTime: Type.Optional(Type.Integer()),
});

const CampaignAddResultSchema = Type.Object({
  added: Type.Integer(),
  skipped: Type.Integer(),
});

export async function registerFilterRoutes(app: FastifyInstance) {
  // All filter routes are gated by `advanced_filters`. The parent
  // `constituentRoutes` registrar is mounted at `/v1`, so the paths
  // below resolve to e.g. `POST /v1/constituents/filter` and
  // `POST /v1/campaigns/:id/members/filter`.
  app.register(async (app) => {
    app.addHook("onRequest", requireAuth);
    app.addHook("onRequest", requireFlag("advanced_filters"));

    /**
     * Execute a filter query and return matching constituents
     */
    app.post<{
      Body: typeof FilterRequestSchema.static;
    }>(
      "/constituents/filter",
      {
        config: { rateLimit: { max: 10, timeWindow: "1 minute" } }, // Rate limit expensive filter operations
        schema: {
          tags: ["constituents"],
          summary: "Execute advanced filter query",
          description:
            "Filter constituents using complex queries with multiple conditions and patterns",
          body: FilterRequestSchema,
          response: {
            200: DataResponse(FilterResultSchema),
            ...ErrorResponses,
          },
        },
      },
      async (request, reply) => {
        if (!request.auth) {
          return reply
            .status(401)
            .send(problemDetail(401, "Authentication Required", "Request requires authentication"));
        }
        const { orgId } = request.auth;
        const filterService = new FilterService(orgId, request.log);

        try {
          // Validate query
          const validation = filterService.validateQuery(request.body.query);
          if (!validation.valid) {
            return reply.status(400).send(
              problemDetail(400, "Invalid filter query", "The filter query contains errors", {
                errors: validation.errors,
              }),
            );
          }

          const result = await filterService.executeFilter(request.body);
          return reply.send({ data: result });
        } catch (error) {
          request.log.error({ error }, "Filter execution failed");
          return reply
            .status(500)
            .send(
              problemDetail(
                500,
                "Filter execution failed",
                error instanceof Error ? error.message : "Unknown error",
              ),
            );
        }
      },
    );

    /**
     * Preview filter results (count only)
     */
    app.post<{
      Body: typeof FilterPreviewRequestSchema.static;
    }>(
      "/constituents/filter/preview",
      {
        config: { rateLimit: { max: 20, timeWindow: "1 minute" } }, // Preview is lighter, allow more
        schema: {
          tags: ["constituents"],
          summary: "Preview filter results",
          description:
            "Get count of constituents matching the filter without returning full results",
          body: FilterPreviewRequestSchema,
          response: {
            200: DataResponse(FilterPreviewResultSchema),
            ...ErrorResponses,
          },
        },
      },
      async (request, reply) => {
        if (!request.auth) {
          return reply
            .status(401)
            .send(problemDetail(401, "Authentication Required", "Request requires authentication"));
        }
        const { orgId } = request.auth;
        const filterService = new FilterService(orgId, request.log);

        try {
          // Validate query
          const validation = filterService.validateQuery(request.body.query);
          if (!validation.valid) {
            return reply.status(400).send(
              problemDetail(400, "Invalid filter query", "The filter query contains errors", {
                errors: validation.errors,
              }),
            );
          }

          const result = await filterService.previewFilter(request.body);
          return reply.send({ data: result });
        } catch (error) {
          request.log.error({ error }, "Filter preview failed");
          return reply
            .status(500)
            .send(
              problemDetail(
                500,
                "Filter preview failed",
                error instanceof Error ? error.message : "Unknown error",
              ),
            );
        }
      },
    );

    /**
     * Get autocomplete suggestions for a field
     */
    app.get<{
      Querystring: typeof FilterSuggestionsRequestSchema.static;
    }>(
      "/constituents/filter/suggestions",
      {
        schema: {
          tags: ["constituents"],
          summary: "Get field value suggestions",
          description: "Get autocomplete suggestions for filterable field values",
          querystring: FilterSuggestionsRequestSchema,
          response: {
            200: Type.Object({ data: Type.Array(Type.String()) }),
            ...ErrorResponses,
          },
        },
      },
      async (request, reply) => {
        if (!request.auth) {
          return reply
            .status(401)
            .send(problemDetail(401, "Authentication Required", "Request requires authentication"));
        }
        const { orgId } = request.auth;
        const filterService = new FilterService(orgId, request.log);

        try {
          const suggestions = await filterService.getFieldSuggestions(request.query);
          return reply.send({ data: suggestions });
        } catch (error) {
          request.log.error({ error }, "Failed to get suggestions");
          return reply
            .status(500)
            .send(
              problemDetail(
                500,
                "Failed to get suggestions",
                error instanceof Error ? error.message : "Unknown error",
              ),
            );
        }
      },
    );

    /**
     * Add filtered constituents to a campaign
     */
    app.post<{
      Params: { id: string };
      Body: typeof CampaignFilterRequestSchema.static;
    }>(
      "/campaigns/:id/members/filter",
      {
        config: { rateLimit: { max: 5, timeWindow: "1 minute" } }, // Campaign operations are expensive
        schema: {
          tags: ["constituents", "campaigns"],
          summary: "Add filtered constituents to campaign",
          description:
            "Execute a filter and add all matching constituents to the specified campaign",
          params: Type.Object({
            id: Type.String({ format: "uuid" }),
          }),
          body: CampaignFilterRequestSchema,
          response: {
            200: DataResponse(CampaignAddResultSchema),
            ...ErrorResponses,
          },
        },
        preHandler: [requireWrite],
      },
      async (request, reply) => {
        if (!request.auth) {
          return reply
            .status(401)
            .send(problemDetail(401, "Authentication Required", "Request requires authentication"));
        }
        const { orgId } = request.auth;
        const { id: campaignId } = request.params;
        const filterService = new FilterService(orgId, request.log);

        try {
          // Validate query
          const validation = filterService.validateQuery(request.body.query);
          if (!validation.valid) {
            return reply.status(400).send(
              problemDetail(400, "Invalid filter query", "The filter query contains errors", {
                errors: validation.errors,
              }),
            );
          }

          const result = await filterService.addFilteredToCampaign(campaignId, request.body.query);
          return reply.send({ data: result });
        } catch (error) {
          request.log.error({ error }, "Failed to add constituents to campaign");

          if (error instanceof Error && error.message === "Campaign not found") {
            return reply
              .status(404)
              .send(
                problemDetail(
                  404,
                  "Campaign not found",
                  "The specified campaign does not exist or you don't have access to it",
                ),
              );
          }

          return reply
            .status(500)
            .send(
              problemDetail(
                500,
                "Failed to add constituents to campaign",
                error instanceof Error ? error.message : "Unknown error",
              ),
            );
        }
      },
    );

    /**
     * Get available filter fields and their metadata
     */
    app.get(
      "/constituents/filter/fields",
      {
        schema: {
          tags: ["constituents"],
          summary: "Get available filter fields",
          description: "Get metadata about all available fields for filtering",
          response: {
            200: DataResponse(
              Type.Object({
                fields: Type.Array(
                  Type.Object({
                    name: Type.String(),
                    type: Type.Union([
                      Type.Literal("string"),
                      Type.Literal("number"),
                      Type.Literal("date"),
                      Type.Literal("boolean"),
                      Type.Literal("array"),
                    ]),
                    operators: Type.Array(FilterOperatorSchema),
                    description: Type.Optional(Type.String()),
                  }),
                ),
                patterns: Type.Array(
                  Type.Object({
                    name: PatternTypeSchema,
                    description: Type.String(),
                  }),
                ),
              }),
            ),
            ...ErrorResponses,
          },
        },
      },
      async (_request, reply) => {
        // Import FIELD_REGISTRY dynamically to avoid circular dependency
        const { FIELD_REGISTRY } = await import("./types.js");

        const fields = Object.values(FIELD_REGISTRY).map((field) => ({
          name: field.name,
          type: field.type,
          operators: field.operators,
        }));

        const patterns = [
          {
            name: "LYBUNT" as const,
            description: "Donors who gave last year but not this year",
          },
          {
            name: "SYBUNT" as const,
            description: "Donors who gave in previous years but not this year",
          },
          {
            name: "RECURRING" as const,
            description: "Donors with regular giving patterns",
          },
          {
            name: "LAPSED" as const,
            description: "Donors who haven't given recently",
          },
          {
            name: "MAJOR_DONOR" as const,
            description: "Donors with high total contribution amounts",
          },
        ];

        return reply.send({ data: { fields, patterns } });
      },
    );
  });
}

/**
 * Register filter routes with the main constituents router
 */
export async function registerFilterEndpoints(app: FastifyInstance) {
  await registerFilterRoutes(app);
}
