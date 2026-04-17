/** Donation routes — list, get, and create donations */

import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../../lib/guards.js";
import { resolveTranslations } from "../../lib/i18n.js";
import { getReceiptPresignedUrl } from "../../lib/s3.js";
import {
  CurrencySchema,
  DataArrayResponse,
  DataResponse,
  ErrorResponses,
  IdParams,
  PaginationQuery,
  problemDetail,
  UuidSchema,
} from "../../lib/schemas.js";
import {
  AllocationSumMismatchError,
  createDonation,
  getDonation,
  getReceiptByDonation,
  listDonations,
} from "./service.js";

const ListQuery = Type.Intersect([
  PaginationQuery,
  Type.Object({
    dateFrom: Type.Optional(Type.String({ format: "date" })),
    dateTo: Type.Optional(Type.String({ format: "date" })),
    amountMin: Type.Optional(Type.Integer({ minimum: 0 })),
    amountMax: Type.Optional(Type.Integer({ minimum: 0 })),
    constituentId: Type.Optional(UuidSchema),
    campaignId: Type.Optional(UuidSchema),
  }),
]);

const AllocationSchema = Type.Object({
  fundId: UuidSchema,
  amountCents: Type.Integer({ minimum: 1 }),
});

const DonationCreateBody = Type.Object({
  constituentId: UuidSchema,
  amountCents: Type.Integer({ minimum: 1 }),
  currency: Type.Optional(CurrencySchema),
  campaignId: Type.Optional(UuidSchema),
  paymentMethod: Type.Optional(Type.String({ maxLength: 50 })),
  paymentRef: Type.Optional(Type.String({ maxLength: 255 })),
  donatedAt: Type.Optional(Type.String({ format: "date-time" })),
  fiscalYear: Type.Optional(Type.Integer()),
  allocations: Type.Optional(Type.Array(AllocationSchema)),
});

/** Idempotency-Key header schema — accepted on financial POST routes for future dedup enforcement */
const IdempotencyKeyHeader = Type.Object({
  "idempotency-key": Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 255,
      description:
        "Client-generated idempotency key for safe retries. Stored for future deduplication enforcement.",
    }),
  ),
});

/** Donation shape returned by the API */
const DonationResponse = Type.Object({
  id: UuidSchema,
  orgId: UuidSchema,
  constituentId: UuidSchema,
  amountCents: Type.Integer(),
  currency: CurrencySchema,
  campaignId: Type.Union([UuidSchema, Type.Null()]),
  paymentMethod: Type.Union([Type.String(), Type.Null()]),
  paymentRef: Type.Union([Type.String(), Type.Null()]),
  donatedAt: Type.String(),
  fiscalYear: Type.Integer(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

const DonationDetailResponse = Type.Object({
  id: UuidSchema,
  orgId: UuidSchema,
  constituentId: UuidSchema,
  amountCents: Type.Integer(),
  currency: CurrencySchema,
  campaignId: Type.Union([UuidSchema, Type.Null()]),
  paymentMethod: Type.Union([Type.String(), Type.Null()]),
  paymentRef: Type.Union([Type.String(), Type.Null()]),
  donatedAt: Type.String(),
  fiscalYear: Type.Integer(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  constituent: Type.Object({
    id: UuidSchema,
    firstName: Type.String(),
    lastName: Type.String(),
    email: Type.Union([Type.String(), Type.Null()]),
  }),
  allocations: Type.Array(
    Type.Object({
      id: UuidSchema,
      fundId: UuidSchema,
      amountCents: Type.Integer(),
    }),
  ),
});

const ReceiptUrlResponse = Type.Object({
  url: Type.String(),
});

export async function donationRoutes(app: FastifyInstance) {
  /** List donations with pagination and filters */
  app.get(
    "/donations",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Donations"],
        querystring: ListQuery,
        response: { 200: DataArrayResponse(DonationResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        const t = resolveTranslations(request);
        return reply.status(401).send(problemDetail(401, "Unauthorized", t("errors.unauthorized")));
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
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Donations"],
        params: IdParams,
        response: { 200: DataResponse(DonationDetailResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const t = resolveTranslations(request);
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", t("errors.unauthorized")));
      }

      const { id } = request.params as { id: string };
      const donation = await getDonation(orgId, id);

      if (!donation) {
        return reply
          .status(404)
          .send(
            problemDetail(
              404,
              "Not Found",
              t("errors.notFound", { resource: t("resources.donation") }),
            ),
          );
      }

      return { data: donation };
    },
  );

  /** Record a manual donation (check, cash, wire) */
  app.post(
    "/donations",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Donations"],
        body: DonationCreateBody,
        headers: IdempotencyKeyHeader,
        response: { 201: DataResponse(DonationResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const t = resolveTranslations(request);
      const orgId = request.auth?.orgId;
      const userId = request.auth?.userId;
      if (!orgId || !userId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", t("errors.unauthorized")));
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

      try {
        const donation = await createDonation(orgId, userId, body);

        if (!donation) {
          return reply.status(404).send({
            type: "https://httpproblems.com/http-status/404",
            title: "Not Found",
            status: 404,
            detail: t("errors.notFound", { resource: t("resources.constituent") }),
          });
        }

        return reply.status(201).send({ data: donation });
      } catch (err) {
        if (err instanceof AllocationSumMismatchError) {
          return reply.status(422).send({
            type: "https://httpproblems.com/http-status/422",
            title: "Unprocessable Entity",
            status: 422,
            detail: err.message,
          });
        }
        throw err;
      }
    },
  );

  /** Get a presigned URL for downloading a donation's tax receipt PDF */
  app.get(
    "/donations/:id/receipt",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Donations"],
        params: IdParams,
        response: { 200: DataResponse(ReceiptUrlResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const t = resolveTranslations(request);
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", t("errors.unauthorized")));
      }

      const { id } = request.params as { id: string };

      // Verify donation belongs to this org before exposing receipt
      const donation = await getDonation(orgId, id);
      if (!donation) {
        return reply
          .status(404)
          .send(
            problemDetail(
              404,
              "Not Found",
              t("errors.notFound", { resource: t("resources.donation") }),
            ),
          );
      }

      const receipt = await getReceiptByDonation(orgId, id);

      if (!receipt) {
        return reply
          .status(404)
          .send(
            problemDetail(
              404,
              "Not Found",
              t("errors.notFound", { resource: t("resources.receipt") }),
            ),
          );
      }

      const url = await getReceiptPresignedUrl(receipt.s3Path);
      return { data: { url } };
    },
  );
}
