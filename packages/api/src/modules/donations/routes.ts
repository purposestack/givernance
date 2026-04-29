/** Donation routes — list, get, and create donations */

import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { requireAuth, requireOrgAdmin, requireWrite } from "../../lib/guards.js";
import { resolveTranslations } from "../../lib/i18n.js";
import { fetchReceiptObject } from "../../lib/s3.js";
import {
  CurrencySchema,
  DataArrayResponse,
  DataResponse,
  ErrorResponses,
  IdParams,
  PaginationQuery,
  ProblemDetailSchema,
  problemDetail,
  SortOrderSchema,
  UuidSchema,
} from "../../lib/schemas.js";
import { getStripe } from "../payments/service.js";
import {
  AllocationSumMismatchError,
  CrossTenantReferenceError,
  createDonation,
  DONATION_SORT_FIELDS,
  deleteDonation,
  getDonation,
  getReceiptByDonation,
  listDonations,
  refundDonation,
  updateDonation,
} from "./service.js";

const ReceiptStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("generated"),
  Type.Literal("failed"),
]);

/**
 * Server-side sort fields whitelist for `GET /donations`. Single source
 * of truth lives in `./service.ts` so the route-level TypeBox literal
 * and the service-level `normalizeDonationSort` fallback can never drift.
 */
const DonationSortFieldSchema = Type.Union(
  DONATION_SORT_FIELDS.map((field) => Type.Literal(field)),
);

const ListQuery = Type.Intersect([
  PaginationQuery,
  Type.Object({
    search: Type.Optional(Type.String({ maxLength: 200 })),
    dateFrom: Type.Optional(Type.String({ format: "date" })),
    dateTo: Type.Optional(Type.String({ format: "date" })),
    amountMin: Type.Optional(Type.Integer({ minimum: 0 })),
    amountMax: Type.Optional(Type.Integer({ minimum: 0 })),
    constituentId: Type.Optional(UuidSchema),
    campaignId: Type.Optional(UuidSchema),
    receiptStatus: Type.Optional(ReceiptStatusSchema),
    sort: Type.Optional(DonationSortFieldSchema),
    order: Type.Optional(SortOrderSchema),
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
  fiscalYear: Type.Union([Type.Integer(), Type.Null()]),
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
  fiscalYear: Type.Union([Type.Integer(), Type.Null()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  constituent: Type.Union([
    Type.Object({ firstName: Type.String(), lastName: Type.String() }),
    Type.Null(),
  ]),
  campaign: Type.Union([Type.Object({ name: Type.String() }), Type.Null()]),
  receiptStatus: Type.Union([
    Type.Literal("pending"),
    Type.Literal("generated"),
    Type.Literal("failed"),
    Type.Null(),
  ]),
});

const DonationStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("cleared"),
  Type.Literal("refunded"),
  Type.Literal("failed"),
]);

const DonationDetailResponse = Type.Object({
  id: UuidSchema,
  orgId: UuidSchema,
  constituentId: UuidSchema,
  amountCents: Type.Integer(),
  currency: CurrencySchema,
  campaignId: Type.Union([UuidSchema, Type.Null()]),
  paymentMethod: Type.Union([Type.String(), Type.Null()]),
  paymentRef: Type.Union([Type.String(), Type.Null()]),
  // Issue #199: exposed so the donation detail UI can hide the refund
  // button on already-refunded rows and the refund flow doesn't surprise
  // a donor who clicked twice.
  status: DonationStatusSchema,
  donatedAt: Type.String(),
  fiscalYear: Type.Union([Type.Integer(), Type.Null()]),
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
      fundName: Type.String(),
      amountCents: Type.Integer(),
    }),
  ),
});

/**
 * The receipt metadata response. `downloadPath` is a relative API path
 * the frontend opens directly — `staging.givernance.org/v1/donations/.../
 * receipt/download` — so the donor-visible URL stays on the app's apex
 * (issue #214). No presigned URL field: presigned URLs would point at
 * the internal Docker hostname `givernance-minio:9000`, unreachable from
 * the browser.
 *
 * `expiresAt` is the caller's auth-token horizon — the path itself is
 * timeless (re-authenticated on every download), but after this instant
 * the user must re-auth and re-call this endpoint. Pre-#214 this field
 * tracked the presigned URL's TTL; the post-#214 meaning is
 * "auth-token-tied" per the issue's design constraint.
 */
const ReceiptUrlResponse = Type.Object({
  downloadPath: Type.String(),
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
        search?: string;
        dateFrom?: string;
        dateTo?: string;
        amountMin?: number;
        amountMax?: number;
        constituentId?: string;
        campaignId?: string;
        receiptStatus?: "pending" | "generated" | "failed";
        sort?: (typeof DONATION_SORT_FIELDS)[number];
        order?: "asc" | "desc";
      };

      const result = await listDonations(orgId, {
        page: query.page ?? 1,
        perPage: query.perPage ?? 20,
        search: query.search,
        dateFrom: query.dateFrom,
        dateTo: query.dateTo,
        amountMin: query.amountMin,
        amountMax: query.amountMax,
        constituentId: query.constituentId,
        campaignId: query.campaignId,
        receiptStatus: query.receiptStatus,
        sort: query.sort,
        order: query.order,
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
      // Issue #181: `minRole` mirrors the route's RBAC guard so the
      // idempotency replay path doesn't short-circuit `requireWrite`.
      config: { idempotency: { routeKey: "POST:/v1/donations", minRole: "write" } },
      preHandler: requireWrite,
      schema: {
        tags: ["Donations"],
        body: DonationCreateBody,
        headers: IdempotencyKeyHeader,
        response: { 201: DataResponse(DonationResponse), ...ErrorResponses },
      },
    },
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: donation create handler walks auth → idempotency → validation → allocation sum → service call → 201/409/422 mapping. Each branch is needed and the linear flow is easier to audit than a split.
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
      preHandler: requireWrite,
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
      preHandler: requireOrgAdmin,
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

  /**
   * Refund a Stripe donation (issue #199). Only org_admins, only Stripe-
   * sourced donations, and only ones not already refunded.
   *
   * The actual donation-row update happens twice for idempotency: once
   * synchronously here for snappy UI, and again on the `charge.refunded`
   * webhook (which the worker handles regardless of refund origin — our
   * UI or the NPO's Stripe dashboard). Both paths set `status =
   * "refunded"`; the second one is a no-op when it sees the row is
   * already refunded.
   */
  app.post(
    "/donations/:id/refund",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Donations"],
        params: IdParams,
        response: {
          200: DataResponse(Type.Object({ id: UuidSchema, status: Type.Literal("refunded") })),
          422: ProblemDetailSchema,
          502: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const t = resolveTranslations(request);
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", t("errors.unauthorized")));
      }

      const { id } = request.params as { id: string };
      const stripe = getStripe();
      const result = await refundDonation(orgId, id, stripe.refunds);

      switch (result.kind) {
        case "ok":
          return { data: { id, status: "refunded" as const } };
        case "not_found":
          return reply
            .status(404)
            .send(
              problemDetail(
                404,
                "Not Found",
                t("errors.notFound", { resource: t("resources.donation") }),
              ),
            );
        case "already_refunded":
          return reply
            .status(422)
            .send(problemDetail(422, "Unprocessable Entity", "Donation already refunded"));
        case "not_stripe":
          return reply
            .status(422)
            .send(
              problemDetail(
                422,
                "Unprocessable Entity",
                "Only Stripe-sourced donations can be refunded through this endpoint",
              ),
            );
        case "stripe_error":
          // Sanitised log; donor-/operator-facing message stays generic
          // (memory: don't leak Stripe internals to authenticated callers).
          request.log.error({ errMessage: result.message, donationId: id }, "Stripe refund failed");
          return reply
            .status(502)
            .send(problemDetail(502, "Bad Gateway", "Payment provider error, please try again"));
      }
    },
  );

  /**
   * Receipt metadata — returns the relative `downloadPath` the frontend
   * opens to actually fetch the PDF. The frontend can decide whether to
   * `window.open(downloadPath)` immediately or render a link for later.
   *
   * Pre-issue-#214 this returned a presigned MinIO URL. That broke on
   * staging because the URL contained the internal Docker hostname
   * (`givernance-minio:9000`, baked into the SigV4 signature so it can't
   * be host-rewritten). The new endpoint streams through `:id/receipt/
   * download` instead, keeping every donor-visible URL on the app's apex
   * — see the URL-consistency rule in CLAUDE.md.
   */
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

      // `jwtExp` is a UNIX-second timestamp set by the auth plugin from
      // the verified JWT's `exp` claim (packages/api/src/plugins/auth.ts).
      // Falls back to "1 hour from now" if the claim is missing — that's
      // a defensive default, not a feature: every Keycloak-issued JWT
      // carries `exp`. The frontend uses this only as a "consider
      // refreshing" hint; the path itself doesn't go stale.
      const expSeconds = request.jwtExp ?? Math.floor(Date.now() / 1000) + 3600;
      const expiresAt = new Date(expSeconds * 1000).toISOString();
      return {
        data: {
          downloadPath: `/v1/donations/${id}/receipt/download`,
          expiresAt,
        },
      };
    },
  );

  /**
   * Stream a donation's receipt PDF inline from MinIO/S3 (issue #214).
   *
   * Auth + tenant scope are enforced on every call (not just at link
   * generation, the way presigned URLs were), so revoking access is
   * immediate. Each call lands a structured log line via the existing
   * pino instance — `userId` + `donationId` + `receiptNumber` so log-side
   * audit can answer "who downloaded what when" without the scattered S3
   * access logs the presigned-URL flow produced.
   *
   * Cache-Control is `private, no-store` because the response includes a
   * legal proof of donation specific to one user; we don't want a shared
   * cache returning the same PDF to a different identity.
   */
  app.get(
    "/donations/:id/receipt/download",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Donations"],
        params: IdParams,
        // Binary streaming response — no JSON envelope; only the error
        // shapes go through the schema. Fastify still validates the
        // params at the schema layer above.
        response: ErrorResponses,
      },
    },
    async (request, reply) => {
      const t = resolveTranslations(request);
      const orgId = request.auth?.orgId;
      const userId = request.auth?.userId;
      if (!orgId || !userId) {
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

      const { body, contentLength } = await fetchReceiptObject(receipt.s3Path);

      // Audit log — single source of truth for "who downloaded this
      // receipt". Indexed in Loki via the existing pino → stdout path
      // (docs/17-log-management.md). receiptNumber is non-PII; fiscalYear
      // helps narrow the search when an NPO asks for a year-of-account
      // export of their download history.
      request.log.info(
        {
          orgId,
          userId,
          donationId: id,
          receiptId: receipt.id,
          receiptNumber: receipt.receiptNumber,
          fiscalYear: receipt.fiscalYear,
        },
        "Receipt downloaded",
      );

      reply
        .header("Content-Type", "application/pdf")
        .header("Content-Disposition", `attachment; filename="${receipt.receiptNumber}.pdf"`)
        .header("Cache-Control", "private, no-store");
      if (contentLength !== undefined) {
        reply.header("Content-Length", contentLength.toString());
      }
      return reply.send(body);
    },
  );
}
