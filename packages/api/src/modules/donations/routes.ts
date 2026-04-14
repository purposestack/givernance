/** Donation routes — list, get, and create donations */

import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../../lib/guards.js";
import { getReceiptPresignedUrl } from "../../lib/s3.js";
import { createDonation, getDonation, getReceiptByDonation, listDonations } from "./service.js";

const IdParams = Type.Object({
  id: Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" }),
});

const ListQuery = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  perPage: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  dateFrom: Type.Optional(Type.String({ format: "date" })),
  dateTo: Type.Optional(Type.String({ format: "date" })),
  amountMin: Type.Optional(Type.Integer({ minimum: 0 })),
  amountMax: Type.Optional(Type.Integer({ minimum: 0 })),
  constituentId: Type.Optional(
    Type.String({
      pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    }),
  ),
  campaignId: Type.Optional(
    Type.String({
      pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    }),
  ),
});

const AllocationSchema = Type.Object({
  fundId: Type.String({
    pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
  }),
  amountCents: Type.Integer({ minimum: 1 }),
});

const DonationCreateBody = Type.Object({
  constituentId: Type.String({
    pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
  }),
  amountCents: Type.Integer({ minimum: 1 }),
  currency: Type.Optional(Type.String({ minLength: 3, maxLength: 3 })),
  campaignId: Type.Optional(
    Type.String({
      pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    }),
  ),
  paymentMethod: Type.Optional(Type.String({ maxLength: 50 })),
  paymentRef: Type.Optional(Type.String({ maxLength: 255 })),
  donatedAt: Type.Optional(Type.String({ format: "date-time" })),
  fiscalYear: Type.Optional(Type.Integer()),
  allocations: Type.Optional(Type.Array(AllocationSchema)),
});

export async function donationRoutes(app: FastifyInstance) {
  /** List donations with pagination and filters */
  app.get(
    "/donations",
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
        dateFrom?: string;
        dateTo?: string;
        amountMin?: number;
        amountMax?: number;
        constituentId?: string;
        campaignId?: string;
      };

      const result = await listDonations(orgId, {
        page: query.page ?? 1,
        perPage: query.perPage ?? 20,
        dateFrom: query.dateFrom,
        dateTo: query.dateTo,
        amountMin: query.amountMin,
        amountMax: query.amountMax,
        constituentId: query.constituentId,
        campaignId: query.campaignId,
      });

      return { data: result.data, pagination: result.pagination };
    },
  );

  /** Get a single donation with constituent and allocations */
  app.get(
    "/donations/:id",
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply
          .status(401)
          .send({ statusCode: 401, error: "Unauthorized", message: "Missing auth context" });
      }

      const { id } = request.params as { id: string };
      const donation = await getDonation(orgId, id);

      if (!donation) {
        return reply.status(404).send({
          type: "https://httpproblems.com/http-status/404",
          title: "Not Found",
          status: 404,
          detail: "Donation not found",
        });
      }

      return { data: donation };
    },
  );

  /** Record a manual donation (check, cash, wire) */
  app.post(
    "/donations",
    { preHandler: requireAuth, schema: { body: DonationCreateBody } },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      const userId = request.auth?.userId;
      if (!orgId || !userId) {
        return reply
          .status(401)
          .send({ statusCode: 401, error: "Unauthorized", message: "Missing auth context" });
      }

      const body = request.body as {
        constituentId: string;
        amountCents: number;
        currency?: string;
        campaignId?: string;
        paymentMethod?: string;
        paymentRef?: string;
        donatedAt?: string;
        fiscalYear?: number;
        allocations?: { fundId: string; amountCents: number }[];
      };

      const donation = await createDonation(orgId, userId, body);
      return reply.status(201).send({ data: donation });
    },
  );

  /** Get a presigned URL for downloading a donation's tax receipt PDF */
  app.get(
    "/donations/:id/receipt",
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply
          .status(401)
          .send({ statusCode: 401, error: "Unauthorized", message: "Missing auth context" });
      }

      const { id } = request.params as { id: string };
      const receipt = await getReceiptByDonation(orgId, id);

      if (!receipt) {
        return reply.status(404).send({
          type: "https://httpproblems.com/http-status/404",
          title: "Not Found",
          status: 404,
          detail: "Receipt not found for this donation",
        });
      }

      const url = await getReceiptPresignedUrl(receipt.s3Path);
      return { data: { url } };
    },
  );
}
