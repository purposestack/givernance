/** Payment routes — Stripe Connect onboarding and webhook handler */

import rateLimit from "@fastify/rate-limit";
import { QUEUE_NAMES } from "@givernance/shared/jobs";
import { Type } from "@sinclair/typebox";
import { Queue } from "bullmq";
import type { FastifyInstance } from "fastify";
import { requireOrgAdmin } from "../../lib/guards.js";
import { redis } from "../../lib/redis.js";
import { DataResponse, ErrorResponses, problemDetail } from "../../lib/schemas.js";
import { createWebhookEvent, startStripeOnboarding, verifyStripeWebhook } from "./service.js";

const webhooksQueue = new Queue(QUEUE_NAMES.WEBHOOKS, { connection: redis });

const StripeConnectBody = Type.Object({
  refreshUrl: Type.String({ minLength: 1 }),
  returnUrl: Type.String({ minLength: 1 }),
});

const StripeConnectResponse = Type.Object({
  url: Type.String(),
  accountId: Type.String(),
});

export async function paymentRoutes(app: FastifyInstance) {
  /**
   * Start Stripe Connect onboarding for the authenticated org.
   * Creates an Express connected account if needed, returns the Account Link URL.
   */
  app.post(
    "/admin/stripe-connect",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Payments"],
        body: StripeConnectBody,
        response: { 200: DataResponse(StripeConnectResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const { refreshUrl, returnUrl } = request.body as {
        refreshUrl: string;
        returnUrl: string;
      };

      try {
        const result = await startStripeOnboarding(orgId, refreshUrl, returnUrl);
        return { data: result };
      } catch (err) {
        request.log.error({ err }, "Stripe Connect onboarding failed");
        return reply
          .status(502)
          .send(problemDetail(502, "Bad Gateway", "Payment provider error, please try again"));
      }
    },
  );
}

/**
 * Webhook route registered in a separate encapsulated context so the
 * raw-body content-type parser doesn't affect other JSON routes.
 */
export async function stripeWebhookRoute(app: FastifyInstance) {
  // Per-IP rate limit for the public webhook endpoint
  await app.register(rateLimit, {
    max: 50,
    timeWindow: "1 minute",
    redis,
  });

  // Override JSON parser to return raw Buffer for signature verification
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  app.post(
    "/donations/stripe-webhook",
    {
      schema: {
        tags: ["Payments"],
        hide: true,
      },
    },
    async (request, reply) => {
      const signature = request.headers["stripe-signature"] as string | undefined;
      if (!signature) {
        return reply
          .status(400)
          .send(problemDetail(400, "Bad Request", "Missing stripe-signature"));
      }

      const rawBody = request.body as Buffer;

      let event: ReturnType<typeof verifyStripeWebhook>;
      try {
        event = verifyStripeWebhook(rawBody, signature);
      } catch {
        request.log.warn("Stripe webhook signature verification failed");
        return reply
          .status(400)
          .send(problemDetail(400, "Bad Request", "Signature verification failed"));
      }

      // Atomic insert with ON CONFLICT — handles both first-seen and duplicate events
      const record = await createWebhookEvent(event);
      if (!record) {
        request.log.info({ stripeEventId: event.id }, "Duplicate webhook event, skipping");
        return reply.status(200).send({ received: true });
      }

      // Enqueue for async processing
      await webhooksQueue.add(
        "process-stripe-webhook",
        {
          webhookEventId: record.id,
          stripeEventId: event.id,
          eventType: event.type,
          accountId: event.account ?? null,
          payload: event.data.object as unknown as Record<string, unknown>,
        },
        { jobId: `stripe-${event.id}` },
      );

      request.log.info({ stripeEventId: event.id, eventType: event.type }, "Webhook event queued");
      return reply.status(200).send({ received: true });
    },
  );
}
