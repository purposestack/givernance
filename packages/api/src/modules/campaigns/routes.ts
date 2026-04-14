/** Campaign routes — list, create campaigns and trigger document generation */

import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { requireAuth, requireOrgAdmin } from "../../lib/guards.js";
import { createCampaign, listCampaigns, requestCampaignDocuments } from "./service.js";

const IdParams = Type.Object({
  id: Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" }),
});

const ListQuery = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  perPage: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
});

const CampaignCreateBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 255 }),
  type: Type.Union([
    Type.Literal("nominative_postal"),
    Type.Literal("door_drop"),
    Type.Literal("digital"),
  ]),
});

const UuidPattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

const DocumentsCreateBody = Type.Object({
  constituentIds: Type.Array(Type.String({ pattern: UuidPattern }), { default: [] }),
});

export async function campaignRoutes(app: FastifyInstance) {
  /** List campaigns with pagination */
  app.get(
    "/campaigns",
    { preHandler: requireAuth, schema: { querystring: ListQuery } },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply
          .status(401)
          .send({ statusCode: 401, error: "Unauthorized", message: "Missing auth context" });
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
    { preHandler: requireAuth, schema: { body: CampaignCreateBody } },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply
          .status(401)
          .send({ statusCode: 401, error: "Unauthorized", message: "Missing auth context" });
      }

      const body = request.body as {
        name: string;
        type: "nominative_postal" | "door_drop" | "digital";
      };
      const campaign = await createCampaign(orgId, body);
      return reply.status(201).send({ data: campaign });
    },
  );

  /** Trigger batch document generation for a campaign */
  app.post(
    "/campaigns/:id/documents",
    { preHandler: requireOrgAdmin, schema: { params: IdParams, body: DocumentsCreateBody } },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      const userId = request.auth?.userId;
      if (!orgId || !userId) {
        return reply
          .status(401)
          .send({ statusCode: 401, error: "Unauthorized", message: "Missing auth context" });
      }

      const { id } = request.params as { id: string };
      const { constituentIds } = request.body as { constituentIds: string[] };

      const result = await requestCampaignDocuments(orgId, userId, id, constituentIds);

      if (!result) {
        return reply.status(404).send({
          type: "https://httpproblems.com/http-status/404",
          title: "Not Found",
          status: 404,
          detail: "Campaign not found",
        });
      }

      return reply.status(202).send({ data: result });
    },
  );
}
