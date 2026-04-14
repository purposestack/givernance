/** Pledge routes — create pledges and list installments */

import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../../lib/guards.js";
import { createPledge, listInstallments } from "./service.js";

const IdParams = Type.Object({
  id: Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" }),
});

const PledgeCreateBody = Type.Object({
  constituentId: Type.String({
    pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
  }),
  amountCents: Type.Integer({ minimum: 1 }),
  currency: Type.Optional(Type.String({ minLength: 3, maxLength: 3 })),
  frequency: Type.Union([Type.Literal("monthly"), Type.Literal("yearly")]),
  stripeCustomerId: Type.Optional(Type.String({ maxLength: 255 })),
  stripeAccountId: Type.Optional(Type.String({ maxLength: 255 })),
  paymentGateway: Type.Optional(Type.String({ maxLength: 50 })),
});

export async function pledgeRoutes(app: FastifyInstance) {
  /** Create a pledge with first year of installments */
  app.post(
    "/pledges",
    { preHandler: requireAuth, schema: { body: PledgeCreateBody } },
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
    { preHandler: requireAuth, schema: { params: IdParams } },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply
          .status(401)
          .send({ statusCode: 401, error: "Unauthorized", message: "Missing auth context" });
      }

      const { id } = request.params as { id: string };
      const installments = await listInstallments(orgId, id);

      if (installments === null) {
        return reply.status(404).send({
          type: "https://httpproblems.com/http-status/404",
          title: "Not Found",
          status: 404,
          detail: "Pledge not found",
        });
      }

      return { data: installments };
    },
  );
}
