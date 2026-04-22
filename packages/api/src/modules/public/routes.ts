/** Public donation routes — unauthenticated endpoints for embeddable donation pages */

import { CampaignPublicPageSchema } from "@givernance/shared/validators";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { requireOrgAdmin } from "../../lib/guards.js";
import { DataResponse, ErrorResponses, problemDetail, UuidSchema } from "../../lib/schemas.js";
import {
  createDonationIntent,
  getAdminPublicPage,
  getPublicPage,
  upsertPublicPage,
} from "./service.js";

const CampaignIdParams = Type.Object({ id: UuidSchema });

const PublicPageResponse = Type.Object({
  id: UuidSchema,
  campaignId: UuidSchema,
  title: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  colorPrimary: Type.Union([Type.String(), Type.Null()]),
  goalAmountCents: Type.Union([Type.Integer(), Type.Null()]),
});

const DonateBody = Type.Object({
  amountCents: Type.Integer({ minimum: 100, maximum: 1000000 }),
  currency: Type.Union([Type.Literal("EUR"), Type.Literal("CHF")]),
  email: Type.String({ format: "email" }),
  firstName: Type.String({ minLength: 1, maxLength: 255 }),
  lastName: Type.String({ minLength: 1, maxLength: 255 }),
});

const DonateHeaders = Type.Object({
  "idempotency-key": Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
});

const DonateResponse = Type.Object({
  clientSecret: Type.String(),
});

const PublicPageCreateBody = CampaignPublicPageSchema;

const PublicPageAdminResponse = Type.Object({
  id: UuidSchema,
  orgId: UuidSchema,
  campaignId: UuidSchema,
  status: Type.Union([Type.Literal("draft"), Type.Literal("published")]),
  title: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  colorPrimary: Type.Union([Type.String(), Type.Null()]),
  goalAmountCents: Type.Union([Type.Integer(), Type.Null()]),
  createdAt: Type.String({ format: "date-time" }),
  updatedAt: Type.String({ format: "date-time" }),
});

export async function publicDonationRoutes(app: FastifyInstance) {
  /** GET /v1/campaigns/:id/public-page — fetch current page config (admin) */
  app.get(
    "/campaigns/:id/public-page",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Campaigns"],
        params: CampaignIdParams,
        response: {
          200: DataResponse(PublicPageAdminResponse),
          400: Type.Any(),
          429: Type.Any(),
          502: Type.Any(),
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
      const page = await getAdminPublicPage(orgId, id);

      if (!page) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Public page not found"));
      }

      return { data: page };
    },
  );

  /** GET /v1/public/campaigns/:id/page — fetch published page config (unauthenticated) */
  app.get(
    "/public/campaigns/:id/page",
    {
      schema: {
        tags: ["Public Donations"],
        params: CampaignIdParams,
        response: {
          200: DataResponse(PublicPageResponse),
          400: Type.Any(),
          429: Type.Any(),
          502: Type.Any(),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const page = await getPublicPage(id);

      if (!page) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Public page not found"));
      }

      return { data: page };
    },
  );

  /** POST /v1/public/campaigns/:id/donate — create Stripe PaymentIntent (unauthenticated) */
  app.post(
    "/public/campaigns/:id/donate",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["Public Donations"],
        params: CampaignIdParams,
        headers: DonateHeaders,
        body: DonateBody,
        response: {
          200: DataResponse(DonateResponse),
          400: Type.Any(),
          429: Type.Any(),
          502: Type.Any(),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        amountCents: number;
        currency: "EUR" | "CHF";
        email: string;
        firstName: string;
        lastName: string;
      };
      const idempotencyKey = (request.headers as Record<string, string | undefined>)[
        "idempotency-key"
      ];

      // Verify the public page is published before accepting donations
      const page = await getPublicPage(id);
      if (!page) {
        return reply
          .status(404)
          .send(problemDetail(404, "Not Found", "Campaign donation page not found"));
      }

      try {
        const result = await createDonationIntent(id, body, idempotencyKey);
        if (!result) {
          return reply.status(404).send(problemDetail(404, "Not Found", "Campaign not found"));
        }
        return { data: result };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Payment processing failed";
        request.log.error({ err: message, campaignId: id }, "Donation intent creation failed");
        return reply
          .status(502)
          .send(problemDetail(502, "Bad Gateway", "Payment processing failed"));
      }
    },
  );

  /** PUT /v1/campaigns/:id/public-page — create or update public page config (admin) */
  app.put(
    "/campaigns/:id/public-page",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Campaigns"],
        params: CampaignIdParams,
        body: PublicPageCreateBody,
        response: {
          200: DataResponse(PublicPageAdminResponse),
          400: Type.Any(),
          429: Type.Any(),
          502: Type.Any(),
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
        title: string;
        description?: string | null;
        colorPrimary?: string | null;
        goalAmountCents?: number | null;
        status?: "draft" | "published";
      };

      const page = await upsertPublicPage(orgId, id, body);
      if (!page) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Campaign not found"));
      }

      return { data: page };
    },
  );
}
