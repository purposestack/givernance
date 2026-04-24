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
  CrossTenantReferenceError,
  createDonation,
  deleteDonation,
  getDonation,
  getReceiptByDonation,
  listDonations,
  updateDonation,
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
  campaignId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  paymentMethod: Type.Optional(Type.String({ maxLength: 50 })),
  paymentRef: Type.Optional(Type.String({ maxLength: 255 })),
  donatedAt: Type.Optional(Type.String({ format: "date-time" })),
  fiscalYear: Type.Optional(Type.Integer()),
  allocations: Type.Optional(Type.Array(AllocationSchema)),
});

const DonationUpdateBody = Type.Object({
  constituentId: UuidSchema,
  amountCents: Type.Integer({ minimum: 1 }),
  currency: Type.Optional(CurrencySchema),
  campaignId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  paymentMethod: Type.Optional(Type.Union([Type.String({ maxLength: 50 }), Type.Null()])),
  paymentRef: Type.Optional(Type.Union([Type.String({ maxLength: 255 }), Type.Null()])),
  donatedAt: Type.Optional(Type.String({ format: "date-time" })),
  fiscalYear: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  allocations: Type.Optional(Type.Array(AllocationSchema)),
});

/**
 * Idempotency-Key header schema.
 *
 * 24h TTL, scoped per-route and per-tenant. A duplicate in-flight request
 * returns 409 + `retry-after`. A completed key replays that response
 * (including `Location` / `ETag` / `Content-Type` / `retry-after` headers)
 * with `idempotency-replayed: true`. Body fingerprint is NOT verified — same
 * key with a different body replays the original response. Non-2xx
 * responses are NOT cached (4xx retries re-run the handler).
 */
const IdempotencyKeyHeader = Type.Object({
  "idempotency-key": Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 255,
      description:
        "Client-supplied idempotency key. Same key within 24h replays the first 2xx response. See plugins/idempotency.ts.",
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

/** Donation list row — enriched with constituent name and latest receipt status for list views */
const DonationListRow = Type.Object({
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
  constituent: Type.Union([
    Type.Object({ firstName: Type.String(), lastName: Type.String() }),
    Type.Null(),
  ]),
  receiptStatus: Type.Union([
    Type.Literal("pending"),
    Type.Literal("generated"),
    Type.Literal("failed"),
    Type.Null(),
  ]),
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
  /** ISO-8601 absolute expiry. Clients can cache the URL safely up to this instant. */
  expiresAt: Type.String({ format: "date-time" }),
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
        response: { 200: DataArrayResponse(DonationListRow), ...ErrorResponses },
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
      config: { idempotency: { routeKey: "POST:/v1/donations" } },
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

        reply.header("Location", `/v1/donations/${donation.id}`);
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
        // Cross-tenant campaign / fund reference → 404 (not 422) so we don't
        // expose whether the id exists at all. Aligns with forthcoming ADR on
        // cross-tenant FK violation semantics.
        if (err instanceof CrossTenantReferenceError) {
          return reply.status(404).send(
            problemDetail(
              404,
              "Not Found",
              t("errors.notFound", {
                resource:
                  err.reference === "campaign" ? t("resources.campaign") : t("resources.fund"),
              }),
            ),
          );
        }
        throw err;
      }
    },
  );

  app.patch(
    "/donations/:id",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Donations"],
        params: IdParams,
        body: DonationUpdateBody,
        response: { 200: DataResponse(DonationResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const t = resolveTranslations(request);
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", t("errors.unauthorized")));
      }

      const { id } = request.params as { id: string };
      const body = request.body as {
        constituentId: string;
        amountCents: number;
        currency?: string;
        campaignId?: string | null;
        paymentMethod?: string | null;
        paymentRef?: string | null;
        donatedAt?: string;
        fiscalYear?: number | null;
        allocations?: { fundId: string; amountCents: number }[];
      };

      try {
        const updated = await updateDonation(orgId, id, body);

        if (!updated) {
          return reply.status(404).send({
            type: "https://httpproblems.com/http-status/404",
            title: "Not Found",
            status: 404,
            detail: t("errors.notFound", { resource: t("resources.donation") }),
          });
        }

        return { data: updated };
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

  app.delete(
    "/donations/:id",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Donations"],
        params: IdParams,
        response: { 200: DataResponse(DonationResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const t = resolveTranslations(request);
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", t("errors.unauthorized")));
      }

      const { id } = request.params as { id: string };
      const deleted = await deleteDonation(orgId, id);

      if (!deleted) {
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

      return { data: deleted };
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

      const { url, expiresAt } = await getReceiptPresignedUrl(receipt.s3Path);
      return { data: { url, expiresAt: expiresAt.toISOString() } };
    },
  );
}
