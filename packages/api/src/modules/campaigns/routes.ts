/** Campaign routes — full CRUD, stats, ROI, document generation, and eligible funds */

import {
  CAMPAIGN_STATUS_VALUES,
  CAMPAIGN_TYPE_VALUES,
  FUND_TYPE_VALUES,
} from "@givernance/shared/schema";
import { MULTI_CURRENCY_VALUES } from "@givernance/shared/validators";
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
  CampaignValidationError,
  closeCampaign,
  createCampaign,
  getCampaign,
  getCampaignRoi,
  getCampaignStats,
  listCampaignFunds,
  listCampaigns,
  requestCampaignDocuments,
  updateCampaign,
} from "./service.js";

/** Shared campaign type TypeBox union built from the canonical CAMPAIGN_TYPE_VALUES */
const CampaignTypeSchema = Type.Union(CAMPAIGN_TYPE_VALUES.map((v) => Type.Literal(v)));

/** Shared campaign status TypeBox union built from the canonical CAMPAIGN_STATUS_VALUES */
const CampaignStatusSchema = Type.Union(CAMPAIGN_STATUS_VALUES.map((v) => Type.Literal(v)));
const CampaignDefaultCurrencySchema = Type.Union(
  MULTI_CURRENCY_VALUES.map((value) => Type.Literal(value)),
);

/**
 * Idempotency-Key header schema.
 *
 * 24h TTL, scoped per-route and per-tenant. A duplicate in-flight request
 * with the same key returns 409 + `retry-after`. A key whose original
 * request already completed replays that response (including `Location`,
 * `ETag`, `Content-Type`, `retry-after` headers) with
 * `idempotency-replayed: true`. Body fingerprint is NOT verified — same key
 * with a different body replays the original response. Non-2xx responses
 * are not cached, so a 4xx retry re-runs the handler.
 */
const IdempotencyKeyHeader = Type.Object({
  "idempotency-key": Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 255,
      description:
        "Client-supplied idempotency key. Same key within 24h replays the first 2xx response. See plugins/idempotency.ts for semantics.",
    }),
  ),
});

const CampaignCreateBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 255 }),
  type: CampaignTypeSchema,
  defaultCurrency: Type.Optional(CampaignDefaultCurrencySchema),
  parentId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  operationalCostCents: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
  fundIds: Type.Optional(Type.Array(UuidSchema)),
});

const CampaignUpdateBody = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    type: Type.Optional(CampaignTypeSchema),
    defaultCurrency: Type.Optional(CampaignDefaultCurrencySchema),
    status: Type.Optional(
      Type.Union([Type.Literal("draft"), Type.Literal("active"), Type.Literal("closed")]),
    ),
    parentId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    operationalCostCents: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
    fundIds: Type.Optional(Type.Array(UuidSchema)),
  },
  { minProperties: 1 },
);

const DocumentsCreateBody = Type.Object({
  constituentIds: Type.Array(UuidSchema, { default: [] }),
});

const CampaignResponse = Type.Object({
  id: UuidSchema,
  orgId: UuidSchema,
  name: Type.String(),
  type: CampaignTypeSchema,
  status: CampaignStatusSchema,
  defaultCurrency: CampaignDefaultCurrencySchema,
  parentId: Type.Union([UuidSchema, Type.Null()]),
  operationalCostCents: Type.Union([Type.Integer(), Type.Null()]),
  platformFeesCents: Type.Integer(),
  goalAmountCents: Type.Union([Type.Integer(), Type.Null()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

const FundTypeSchema = Type.Union(FUND_TYPE_VALUES.map((value) => Type.Literal(value)));

const CampaignFundResponse = Type.Object({
  id: UuidSchema,
  orgId: UuidSchema,
  name: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  type: FundTypeSchema,
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

const DocumentsResult = Type.Object({
  campaignId: UuidSchema,
  documentCount: Type.Integer(),
});

const CampaignStatsResponse = Type.Object({
  campaignId: UuidSchema,
  totalRaisedCents: Type.Integer(),
  donationCount: Type.Integer(),
  uniqueDonors: Type.Integer(),
});

const CampaignRoiResponse = Type.Object({
  campaignId: UuidSchema,
  rawGoalCents: Type.Union([Type.Integer(), Type.Null()]),
  rawRaisedCents: Type.Integer(),
  rawPlatformFeesCents: Type.Integer(),
  rawOperationalCostCents: Type.Union([Type.Integer(), Type.Null()]),
  totalCostCents: Type.Integer(),
  roiPct: Type.Union([Type.Number(), Type.Null()]),
});

export async function campaignRoutes(app: FastifyInstance) {
  /** List campaigns with pagination */
  app.get(
    "/campaigns",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Campaigns"],
        querystring: PaginationQuery,
        response: { 200: DataArrayResponse(CampaignResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const query = request.query as { page?: number; perPage?: number };
      const result = await listCampaigns(orgId, {
        page: query.page ?? 1,
        perPage: query.perPage ?? 20,
      });

      return { data: result.data, pagination: result.pagination };
    },
  );

  /** Create a new campaign */
  app.post(
    "/campaigns",
    {
      config: { idempotency: { routeKey: "POST:/v1/campaigns" } },
      preHandler: requireAuth,
      schema: {
        tags: ["Campaigns"],
        body: CampaignCreateBody,
        headers: IdempotencyKeyHeader,
        response: {
          201: DataResponse(CampaignResponse),
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

      const userId = request.auth?.userId;
      const body = request.body as {
        name: string;
        type: "nominative_postal" | "door_drop" | "digital";
        defaultCurrency?: "EUR" | "GBP" | "CHF";
        parentId?: string | null;
        operationalCostCents?: number | null;
        fundIds?: string[];
      };
      try {
        const campaign = await createCampaign(orgId, body, userId);
        if (!campaign) {
          return reply
            .status(404)
            .send(problemDetail(404, "Not Found", "Parent campaign not found"));
        }
        reply.header("Location", `/v1/campaigns/${campaign.id}`);
        return reply.status(201).send({ data: campaign });
      } catch (err) {
        if (err instanceof CampaignValidationError) {
          return reply.status(400).send(problemDetail(400, "Bad Request", err.message));
        }
        throw err;
      }
    },
  );

  /** Get a single campaign by ID */
  app.get(
    "/campaigns/:id",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Campaigns"],
        params: IdParams,
        response: { 200: DataResponse(CampaignResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const { id } = request.params as { id: string };
      const campaign = await getCampaign(orgId, id);

      if (!campaign) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Campaign not found"));
      }

      return { data: campaign };
    },
  );

  /** Update a campaign (partial update) */
  app.patch(
    "/campaigns/:id",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Campaigns"],
        params: IdParams,
        body: CampaignUpdateBody,
        response: {
          200: DataResponse(CampaignResponse),
          400: ProblemDetailSchema,
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
      const body = request.body as {
        name?: string;
        type?: "nominative_postal" | "door_drop" | "digital";
        defaultCurrency?: "EUR" | "GBP" | "CHF";
        status?: "draft" | "active" | "closed";
        parentId?: string | null;
        operationalCostCents?: number | null;
        fundIds?: string[];
      };

      try {
        const updated = await updateCampaign(orgId, id, body, userId);

        if (!updated) {
          return reply.status(404).send(problemDetail(404, "Not Found", "Campaign not found"));
        }

        return { data: updated };
      } catch (err) {
        if (err instanceof CampaignValidationError) {
          return reply.status(400).send(problemDetail(400, "Bad Request", err.message));
        }
        throw err;
      }
    },
  );

  /** List funds eligible for a campaign */
  app.get(
    "/campaigns/:id/funds",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Campaigns"],
        params: IdParams,
        response: { 200: DataArrayResponseNoPagination(CampaignFundResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const { id } = request.params as { id: string };
      const funds = await listCampaignFunds(orgId, id);

      if (!funds) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Campaign not found"));
      }

      return { data: funds };
    },
  );

  /** Close a campaign (soft delete — sets status to 'closed') */
  app.post(
    "/campaigns/:id/close",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Campaigns"],
        params: IdParams,
        response: { 200: DataResponse(CampaignResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      const userId = request.auth?.userId;
      if (!orgId || !userId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const { id } = request.params as { id: string };
      const closed = await closeCampaign(orgId, id, userId);

      if (!closed) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Campaign not found"));
      }

      return { data: closed };
    },
  );

  /** Get campaign stats: total raised, donation count, unique donors */
  app.get(
    "/campaigns/:id/stats",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Campaigns"],
        params: IdParams,
        response: { 200: DataResponse(CampaignStatsResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const { id } = request.params as { id: string };
      const stats = await getCampaignStats(orgId, id);

      if (!stats) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Campaign not found"));
      }

      return { data: stats };
    },
  );

  /** Get campaign ROI read-model */
  app.get(
    "/campaigns/:id/roi",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Campaigns"],
        params: IdParams,
        response: { 200: DataResponse(CampaignRoiResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const { id } = request.params as { id: string };
      const roi = await getCampaignRoi(orgId, id);

      if (!roi) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Campaign not found"));
      }

      return { data: roi };
    },
  );

  /** Trigger batch document generation for a campaign */
  app.post(
    "/campaigns/:id/documents",
    {
      config: { idempotency: { routeKey: "POST:/v1/campaigns/:id/documents" } },
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Campaigns"],
        params: IdParams,
        body: DocumentsCreateBody,
        headers: IdempotencyKeyHeader,
        response: { 202: DataResponse(DocumentsResult), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      const userId = request.auth?.userId;
      if (!orgId || !userId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const { id } = request.params as { id: string };
      const { constituentIds } = request.body as { constituentIds: string[] };

      const result = await requestCampaignDocuments(orgId, userId, id, constituentIds);

      if (!result) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Campaign not found"));
      }

      // `Location` points clients at the polling resource for this job — they
      // can GET the campaign to watch document statuses move from "pending"
      // to "generated". Issue #56 API minor.
      reply.header("Location", `/v1/campaigns/${id}`);
      return reply.status(202).send({ data: result });
    },
  );
}
