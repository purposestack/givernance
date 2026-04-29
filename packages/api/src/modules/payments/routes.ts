/** Payment routes — Stripe Connect onboarding and webhook handler */

import rateLimit from "@fastify/rate-limit";
import { QUEUE_NAMES } from "@givernance/shared/jobs";
import { Type } from "@sinclair/typebox";
import { Queue } from "bullmq";
import type { FastifyInstance } from "fastify";
import { requireOrgAdmin } from "../../lib/guards.js";
import { redis } from "../../lib/redis.js";
import {
  DataResponse,
  ErrorResponses,
  ProblemDetailSchema,
  problemDetail,
} from "../../lib/schemas.js";
import {
  createWebhookEvent,
  getStripeConnectStatus,
  startStripeOnboarding,
  verifyStripeWebhook,
} from "./service.js";

const webhooksQueue = new Queue(QUEUE_NAMES.WEBHOOKS, { connection: redis });

/**
 * Pino-safe shape for Stripe error logging. The raw `Stripe.errors.StripeError`
 * carries `requestId`, full message, raw HTTP body, and possibly tenant-scoped
 * ids (`account`, `payment_intent.id`) which would cross-contaminate a shared
 * log index. `{message, code}` is enough to triage a 502 in ops without
 * spilling identifiers across tenants.
 */
function logStripeError(err: unknown) {
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    return code ? { errMessage: err.message, errCode: code } : { errMessage: err.message };
  }
  return { errMessage: String(err) };
}

const StripeConnectBody = Type.Object({
  /** Stripe redirects here if the operator abandons the hosted onboarding form. */
  refreshUrl: Type.String({ minLength: 1, format: "uri" }),
  /** Stripe redirects here when the operator finishes (or short-circuits) onboarding. */
  returnUrl: Type.String({ minLength: 1, format: "uri" }),
});

/**
 * POST response — `accountId` is **always** populated since we either
 * created the account in this call or returned an existing one. Contrast
 * with `StripeConnectStatusResponse.accountId` which is nullable.
 */
const StripeConnectResponse = Type.Object({
  url: Type.String(),
  accountId: Type.String(),
});

const StripeCapabilityStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("pending"),
  Type.Literal("inactive"),
  Type.Literal("unrequested"),
]);

/**
 * GET response — the "connection status" resource always exists for any
 * authenticated org, but `accountId` is `null` when the tenant has not yet
 * onboarded. Contrast with `StripeConnectResponse.accountId` (POST) which
 * is non-null because POST always produces an account.
 *
 * `requirementsCurrentlyDue` + `disabledReason` + per-capability statuses
 * (issue #201) let the Settings UI tell the operator *why* charges aren't
 * enabled instead of "Onboarding incomplete" with no remediation hint.
 */
const StripeConnectStatusResponse = Type.Object({
  accountId: Type.Union([Type.String(), Type.Null()]),
  chargesEnabled: Type.Boolean(),
  payoutsEnabled: Type.Boolean(),
  detailsSubmitted: Type.Boolean(),
  requirementsCurrentlyDue: Type.Array(Type.String()),
  disabledReason: Type.Union([Type.String(), Type.Null()]),
  capabilities: Type.Object({
    cardPayments: StripeCapabilityStatusSchema,
    transfers: StripeCapabilityStatusSchema,
    linkPayments: StripeCapabilityStatusSchema,
  }),
});

export async function paymentRoutes(app: FastifyInstance) {
  /**
   * Read Stripe Connect status for the authenticated org. Returns a
   * "not connected" shape (`accountId: null`, all flags false) when the
   * tenant has no Stripe account yet so the settings UI can render a
   * single panel without a 404 branch. Calls `accounts.retrieve` on Stripe
   * for live capability flags — per-route rate-limited so a misbehaving
   * Settings page can't burn the platform's Stripe API budget.
   */
  app.get(
    "/admin/stripe-connect",
    {
      preHandler: requireOrgAdmin,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["Payments"],
        response: {
          200: DataResponse(StripeConnectStatusResponse),
          502: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      try {
        const status = await getStripeConnectStatus(orgId);
        return { data: status };
      } catch (err) {
        request.log.error(logStripeError(err), "Stripe Connect status fetch failed");
        return reply
          .status(502)
          .send(problemDetail(502, "Bad Gateway", "Payment provider error, please try again"));
      }
    },
  );

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
        response: {
          200: DataResponse(StripeConnectResponse),
          502: ProblemDetailSchema,
          ...ErrorResponses,
        },
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
        request.log.error(logStripeError(err), "Stripe Connect onboarding failed");
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
  // Per-IP rate limit for the public webhook endpoint. 300/min: Stripe sends
  // from a small fixed pool of source IPs, so legitimate burst traffic
  // (Black-Friday-scale donation spike) shares a single source — too low a
  // cap forces Stripe into exponential-backoff retries and queues up
  // donations on its side. 50 was overly conservative.
  //
  // Defence-in-depth at the edge (PR #193 review, finding #5): Stripe
  // publishes its webhook source IPs at
  // https://stripe.com/docs/ips#webhook-notifications. In production, the
  // platform proxy / reverse-proxy SHOULD allowlist those IPs so an
  // attacker can't drown legitimate webhook traffic by burning the per-IP
  // rate limit. This is infra-side config, not application code. Today
  // signature verification on every event is the primary defence; the
  // rate limit + allowlist together protect availability.
  await app.register(rateLimit, {
    max: 300,
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
