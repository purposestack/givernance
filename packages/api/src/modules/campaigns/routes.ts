/** Campaign routes — full CRUD, stats, ROI, and document generation */

import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { requireAuth, requireOrgAdmin } from "../../lib/guards.js";
import {
  DataArrayResponse,
  DataResponse,
  ErrorResponses,
  IdParams,
  PaginationQuery,
  problemDetail,
  UuidSchema,
} from "../../lib/schemas.js";
import {
  closeCampaign,
  createCampaign,
  getCampaign,
  getCampaignRoi,
  getCampaignStats,
  listCampaigns,
  requestCampaignDocuments,
  updateCampaign,
} from "./service.js";

const CampaignTypeEnum = Type.Union([
  Type.Literal("nominative_postal"),
  Type.Literal("door_drop"),
  Type.Literal("digital"),
]);

const CampaignCreateBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 255 }),
  type: CampaignTypeEnum,
  parentId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  costCents: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
});

const CampaignUpdateBody = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    type: Type.Optional(CampaignTypeEnum),
    status: Type.Optional(
      Type.Union([Type.Literal("draft"), Type.Literal("active"), Type.Literal("closed")]),
    ),
    parentId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    costCents: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
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
  type: Type.String(),
  status: Type.String(),
  parentId: Type.Union([UuidSchema, Type.Null()]),
  costCents: Type.Union([Type.Integer(), Type.Null()]),
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
  totalRaisedCents: Type.Integer(),
  costCents: Type.Integer(),
  roi: Type.Union([Type.Number(), Type.Null()]),
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
      preHandler: requireAuth,
      schema: {
        tags: ["Campaigns"],
        body: CampaignCreateBody,
        response: { 201: DataResponse(CampaignResponse), ...ErrorResponses },
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
        parentId?: string | null;
        costCents?: number | null;
      };
      const campaign = await createCampaign(orgId, body, userId);
      return reply.status(201).send({ data: campaign });
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
  app.put(
    "/campaigns/:id",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Campaigns"],
        params: IdParams,
        body: CampaignUpdateBody,
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
      const body = request.body as {
        name?: string;
        type?: "nominative_postal" | "door_drop" | "digital";
        status?: "draft" | "active" | "closed";
        parentId?: string | null;
        costCents?: number | null;
      };

      const updated = await updateCampaign(orgId, id, body, userId);

      if (!updated) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Campaign not found"));
      }

      return { data: updated };
    },
  );

  /** Close a campaign (soft delete — sets status to 'closed') */
  app.delete(
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

  /** Get campaign ROI: (totalRaised - costCents) / costCents */
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
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Campaigns"],
        params: IdParams,
        body: DocumentsCreateBody,
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

      return reply.status(202).send({ data: result });
    },
  );
}
