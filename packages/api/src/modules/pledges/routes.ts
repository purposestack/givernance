/** Pledge routes — create pledges and list installments */

import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { requireAuth, requireWrite } from "../../lib/guards.js";
import {
  CurrencySchema,
  DataArrayResponseNoPagination,
  DataResponse,
  ErrorResponses,
  IdParams,
  problemDetail,
  UuidSchema,
} from "../../lib/schemas.js";
import { createPledge, listInstallments } from "./service.js";

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

const PledgeCreateBody = Type.Object({
  constituentId: UuidSchema,
  amountCents: Type.Integer({ minimum: 1 }),
  currency: Type.Optional(CurrencySchema),
  frequency: Type.Union([Type.Literal("monthly"), Type.Literal("yearly")]),
  stripeCustomerId: Type.Optional(Type.String({ maxLength: 255 })),
  stripeAccountId: Type.Optional(Type.String({ maxLength: 255 })),
  paymentGateway: Type.Optional(Type.String({ maxLength: 50 })),
});

const PledgeResponse = Type.Object({
  id: UuidSchema,
  orgId: UuidSchema,
  constituentId: UuidSchema,
  amountCents: Type.Integer(),
  currency: CurrencySchema,
  frequency: Type.String(),
  status: Type.String(),
  stripeCustomerId: Type.Union([Type.String(), Type.Null()]),
  stripeAccountId: Type.Union([Type.String(), Type.Null()]),
  paymentGateway: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

const InstallmentResponse = Type.Object({
  id: UuidSchema,
  orgId: UuidSchema,
  pledgeId: UuidSchema,
  donationId: Type.Union([UuidSchema, Type.Null()]),
  expectedAt: Type.String(),
  status: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

export async function pledgeRoutes(app: FastifyInstance) {
  /** Create a pledge with first year of installments */
  app.post(
    "/pledges",
    {
      // Issue #181: `minRole` mirrors `requireWrite` so the idempotency
      // replay branch enforces the same role check the guard would.
      config: { idempotency: { routeKey: "POST:/v1/pledges", minRole: "write" } },
      preHandler: requireWrite,
      schema: {
        tags: ["Pledges"],
        body: PledgeCreateBody,
        headers: IdempotencyKeyHeader,
        response: { 201: DataResponse(PledgeResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      const userId = request.auth?.userId;
      if (!orgId || !userId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const body = request.body as {
        constituentId: string;
        amountCents: number;
        currency?: string;
        frequency: "monthly" | "yearly";
        stripeCustomerId?: string;
        stripeAccountId?: string;
        paymentGateway?: string;
      };

      const pledge = await createPledge(orgId, userId, body);
      if (pledge) {
        reply.header("Location", `/v1/pledges/${pledge.id}`);
      }
      return reply.status(201).send({ data: pledge });
    },
  );

  /** List installments for a pledge */
  app.get(
    "/pledges/:id/installments",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Pledges"],
        params: IdParams,
        response: {
          200: DataArrayResponseNoPagination(InstallmentResponse),
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
      const installments = await listInstallments(orgId, id);

      if (installments === null) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Pledge not found"));
      }

      return { data: installments };
    },
  );
}
