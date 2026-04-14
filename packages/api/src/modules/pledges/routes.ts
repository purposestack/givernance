/** Pledge routes — create pledges and list installments */

import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../../lib/guards.js";
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
  id: Type.String(),
  orgId: Type.String(),
  constituentId: Type.String(),
  amountCents: Type.Integer(),
  currency: Type.String(),
  frequency: Type.String(),
  status: Type.String(),
  stripeCustomerId: Type.Union([Type.String(), Type.Null()]),
  stripeAccountId: Type.Union([Type.String(), Type.Null()]),
  paymentGateway: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

const InstallmentResponse = Type.Object({
  id: Type.String(),
  orgId: Type.String(),
  pledgeId: Type.String(),
  donationId: Type.Union([Type.String(), Type.Null()]),
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
      preHandler: requireAuth,
      schema: {
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
      return reply.status(201).send({ data: pledge });
    },
  );

  /** List installments for a pledge */
  app.get(
    "/pledges/:id/installments",
    {
      preHandler: requireAuth,
      schema: {
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
