/** Public donation routes — unauthenticated endpoints for embeddable donation pages */

import { CampaignPublicPageSchema } from "@givernance/shared/validators";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { requireOrgAdmin } from "../../lib/guards.js";
import {
  DataResponse,
  ErrorResponses,
  ProblemDetailSchema,
  problemDetail,
  UuidSchema,
} from "../../lib/schemas.js";
import {
  createDonationIntent,
  getAdminPublicPage,
  getPublicPage,
  resolveCampaignQrCode,
  upsertPublicPage,
} from "./service.js";

const CampaignIdParams = Type.Object({ id: UuidSchema });

/**
 * Currencies the public donation flow accepts. Narrower than the application
 * `CurrencySchema` (which covers internal-reporting currencies) — we only
 * accept what Stripe Connect direct-charge supports natively across our
 * primary target jurisdictions today. Used in both request body validation
 * and the published-page response shape so they cannot drift.
 */
const PublicDonationCurrencySchema = Type.Union([
  Type.Literal("EUR"),
  Type.Literal("GBP"),
  Type.Literal("CHF"),
]);

const PublicPageResponse = Type.Object({
  id: UuidSchema,
  campaignId: UuidSchema,
  title: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  colorPrimary: Type.Union([Type.String(), Type.Null()]),
  goalAmountCents: Type.Union([Type.Integer(), Type.Null()]),
  defaultCurrency: PublicDonationCurrencySchema,
  /**
   * Connected account id for the campaign's tenant. Null when the tenant
   * hasn't onboarded with Stripe yet (donor flow blocks at the donate step
   * with a 502 in that case). Public per Stripe docs — donor's Stripe.js
   * binds to it for both intent confirmation and 3DS post-redirect retrieve.
   */
  stripeAccountId: Type.Union([Type.String(), Type.Null()]),
  /**
   * Cumulative cleared donations against this campaign in the tenant's base
   * currency (issue #200). Drives the public hero's progress bar.
   */
  raisedCents: Type.Integer(),
  /**
   * Distinct donor count for cleared donations (issue #200). Anonymous
   * donors get a fresh constituent row per gift, which slightly inflates
   * the count — acceptable since donor-count is a social-proof signal,
   * not an audit number.
   */
  donorCount: Type.Integer(),
  /**
   * Org identity for the donor-facing hero (Epic #274 follow-up). Public
   * by design — the org name is already on every printed postal letter
   * and the mission is the donor-facing pitch line.
   * `Type.Optional` so legacy clients that don't request these fields
   * keep round-tripping cleanly through fast-json-stringify (same
   * defensive posture as `tenants.mission` on the admin response).
   */
  organisationName: Type.Optional(Type.String()),
  organisationMission: Type.Optional(Type.Union([Type.Null(), Type.String()])),
});

const DonateBody = Type.Object({
  amountCents: Type.Integer({ minimum: 100, maximum: 1000000 }),
  currency: PublicDonationCurrencySchema,
  email: Type.String({ format: "email" }),
  firstName: Type.String({ minLength: 1, maxLength: 255 }),
  lastName: Type.String({ minLength: 1, maxLength: 255 }),
  /**
   * Optional opaque QR token (Epic #274). When present and resolvable,
   * the resulting donation gets `qr_code_id` populated in the webhook
   * handler so the campaign QR-tracking widget can reconcile postal-scan
   * donations.
   */
  qrCode: Type.Optional(Type.String({ minLength: 10, maxLength: 32 })),
});

const DonateHeaders = Type.Object({
  /**
   * Forwarded directly to Stripe's `paymentIntents.create` as the SDK-level
   * idempotency key. **Not** stored in the application's idempotency table
   * — the route is unauthenticated and the local plugin keys on
   * `(orgId, route, fingerprint)` which we don't have here. Practical
   * effects: a retry that fails before reaching Stripe is NOT deduped on
   * our side; a retry that reaches Stripe will get the original
   * PaymentIntent back. If you ever need local dedup on this route, key
   * on `(publicPage.orgId, campaignId, sha256(headerValue))`.
   */
  "idempotency-key": Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
});

const DonateResponse = Type.Object({
  clientSecret: Type.String(),
  stripeAccountId: Type.String(),
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

  /**
   * GET /v1/public/qr/:code — resolve an opaque campaign QR-code token.
   *
   * Scoped under rate-limiting (unauthenticated) and returns 404 for unknown
   * codes so a scraper can't distinguish "never issued" from "issued for
   * another tenant". Response reveals only the campaign id + optional
   * constituent id the code was bound to, which the public page uses to
   * pre-fill the donation form.
   */
  app.get(
    "/public/qr/:code",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["Public Donations"],
        params: Type.Object({ code: Type.String({ minLength: 10, maxLength: 32 }) }),
        response: {
          200: DataResponse(
            Type.Object({
              campaignId: UuidSchema,
              constituentId: Type.Union([UuidSchema, Type.Null()]),
            }),
          ),
          404: Type.Any(),
          429: Type.Any(),
        },
      },
    },
    async (request, reply) => {
      const { code } = request.params as { code: string };
      const resolved = await resolveCampaignQrCode(code);

      if (!resolved) {
        return reply.status(404).send(problemDetail(404, "Not Found", "QR code not found"));
      }

      return {
        data: {
          campaignId: resolved.campaignId,
          constituentId: resolved.constituentId,
        },
      };
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
          400: ProblemDetailSchema,
          404: ProblemDetailSchema,
          429: ProblemDetailSchema,
          502: ProblemDetailSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        amountCents: number;
        currency: "EUR" | "GBP" | "CHF";
        email: string;
        firstName: string;
        lastName: string;
        qrCode?: string;
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
          // `createDonationIntent` returns `null` for several distinct reasons
          // (invalid uuid, no public page found, no campaign row) — collapsing
          // to a single 404 is deliberate so an enumerator can't distinguish
          // "campaign exists but unpublished" from "campaign doesn't exist".
          return reply.status(404).send(problemDetail(404, "Not Found", "Campaign not found"));
        }
        return { data: result };
      } catch (err) {
        // Sanitised log: drop the raw Stripe Error object — it carries
        // `requestId`, `payment_intent.id`, and possibly the connected
        // `acct_…` id which would cross tenant boundaries in a shared log
        // index. The donor-facing 502 stays generic; ops can recover the
        // raw error from Stripe's dashboard via the donor email + timestamp.
        const errMessage = err instanceof Error ? err.message : "Payment processing failed";
        const errCode = err instanceof Error ? (err as { code?: string }).code : undefined;
        request.log.error(
          { errMessage, errCode, campaignId: id },
          "Donation intent creation failed",
        );
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
