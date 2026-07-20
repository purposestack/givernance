/**
 * Campaign fund routing routes — CRUD for the campaign_funds junction table.
 *
 * All four routes are gated behind the `donation.fund_routing` feature flag
 * (ADR-032 §2.5, Epic #416 Task 4). The flag must be the FIRST preHandler
 * so scanners see 404 without enumerating role requirements.
 *
 *   GET    /v1/campaigns/:id/funds        — list fund routing entries
 *   POST   /v1/campaigns/:id/funds        — add a fund to the campaign
 *   PATCH  /v1/campaigns/:id/funds/:fundId — update a routing entry
 *   DELETE /v1/campaigns/:id/funds/:fundId — remove a fund from the campaign
 */

import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { requireFlag } from "../../lib/flags/flag-guard.js";
import { requireAuth, requireBankMutationAcr, requireOrgAdmin } from "../../lib/guards.js";
import {
  DataArrayResponseNoPagination,
  DataResponse,
  ErrorResponses,
  IdParams,
  ProblemDetailSchema,
  problemDetail,
  UuidSchema,
} from "../../lib/schemas.js";
import {
  addCampaignFund,
  CampaignFundConflictError,
  CampaignFundInvariantError,
  CampaignFundNotFoundError,
  listCampaignFundRouting,
  removeCampaignFund,
  updateCampaignFund,
} from "./campaign-funds.service.js";

// ─── Schemas ──────────────────────────────────────────────────────────────────

/**
 * Params for routes that address a specific fund within a campaign.
 * `:id` = campaignId, `:fundId` = the fund's UUID.
 */
const CampaignFundParams = Type.Object({
  id: UuidSchema,
  fundId: UuidSchema,
});

/**
 * Response shape for a single campaign-fund routing entry.
 *
 * `splitPct` is a nullable string (Postgres NUMERIC is returned as a string
 * by the pg driver to preserve decimal precision). `null` is valid when only
 * one fund is assigned (100 % is implicit).
 */
const CampaignFundRoutingResponse = Type.Object({
  id: UuidSchema,
  campaignId: UuidSchema,
  fundId: UuidSchema,
  fundName: Type.String(),
  splitPct: Type.Union([Type.String(), Type.Null()]),
  isOnlineDefault: Type.Boolean(),
  sortOrder: Type.Integer(),
  settlementCurrency: Type.Union([Type.String(), Type.Null()]),
});

/**
 * Request body for POST /v1/campaigns/:id/funds.
 *
 * `splitPct` is a string-encoded decimal to avoid JavaScript floating-point
 * rounding (e.g. "33.33", "33.34", "33.33"). The service stores it as
 * NUMERIC(5,2) so at most two decimal places.
 */
const AddCampaignFundBody = Type.Object({
  fundId: UuidSchema,
  splitPct: Type.Optional(
    Type.Union([Type.String({ pattern: "^\\d{1,3}(\\.\\d{1,2})?$" }), Type.Null()]),
  ),
  isOnlineDefault: Type.Optional(Type.Boolean()),
  sortOrder: Type.Optional(Type.Integer({ minimum: 0, maximum: 32767 })),
});

/**
 * Request body for PATCH /v1/campaigns/:id/funds/:fundId.
 * At least one property must be present.
 */
const UpdateCampaignFundBody = Type.Object(
  {
    splitPct: Type.Optional(
      Type.Union([Type.String({ pattern: "^\\d{1,3}(\\.\\d{1,2})?$" }), Type.Null()]),
    ),
    isOnlineDefault: Type.Optional(Type.Boolean()),
    sortOrder: Type.Optional(Type.Integer({ minimum: 0, maximum: 32767 })),
  },
  { minProperties: 1 },
);

// ─── Route Plugin ─────────────────────────────────────────────────────────────

export async function campaignFundRoutes(app: FastifyInstance) {
  /** List fund routing entries for a campaign */
  app.get(
    "/campaigns/:id/funds/routing",
    {
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.DONATION_FUND_ROUTING), requireAuth],
      schema: {
        tags: ["Campaigns", "Funds"],
        params: IdParams,
        response: {
          200: DataArrayResponseNoPagination(CampaignFundRoutingResponse),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const { id: campaignId } = request.params as { id: string };
      const rows = await listCampaignFundRouting(campaignId, orgId);

      if (rows === null) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Campaign not found"));
      }

      return { data: rows };
    },
  );

  /** Add a fund to a campaign's routing table */
  app.post(
    "/campaigns/:id/funds/routing",
    {
      preHandler: [
        requireFlag(FEATURE_FLAG_KEYS.DONATION_FUND_ROUTING),
        // These routes exist solely to rebind where a campaign's money settles,
        // so they carry the same blast radius as a bank-account mutation (B5):
        // org_admin + a fresh MFA step-up, unconditionally.
        requireOrgAdmin,
        requireBankMutationAcr(),
      ],
      schema: {
        tags: ["Campaigns", "Funds"],
        params: IdParams,
        body: AddCampaignFundBody,
        response: {
          201: DataResponse(CampaignFundRoutingResponse),
          409: ProblemDetailSchema,
          422: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const { id: campaignId } = request.params as { id: string };
      const body = request.body as {
        fundId: string;
        splitPct?: string | null;
        isOnlineDefault?: boolean;
        sortOrder?: number;
      };

      try {
        const row = await addCampaignFund(campaignId, orgId, body);
        reply.header("Location", `/v1/campaigns/${campaignId}/funds/routing`);
        return reply.status(201).send({ data: row });
      } catch (err) {
        if (err instanceof CampaignFundNotFoundError) {
          return reply.status(404).send(problemDetail(404, "Not Found", err.message));
        }
        if (err instanceof CampaignFundConflictError) {
          return reply.status(409).send(problemDetail(409, "Conflict", err.message));
        }
        if (err instanceof CampaignFundInvariantError) {
          return reply.status(422).send(problemDetail(422, "Unprocessable Entity", err.message));
        }
        throw err;
      }
    },
  );

  /** Update a fund routing entry (partial patch) */
  app.patch(
    "/campaigns/:id/funds/routing/:fundId",
    {
      preHandler: [
        requireFlag(FEATURE_FLAG_KEYS.DONATION_FUND_ROUTING),
        // These routes exist solely to rebind where a campaign's money settles,
        // so they carry the same blast radius as a bank-account mutation (B5):
        // org_admin + a fresh MFA step-up, unconditionally.
        requireOrgAdmin,
        requireBankMutationAcr(),
      ],
      schema: {
        tags: ["Campaigns", "Funds"],
        params: CampaignFundParams,
        body: UpdateCampaignFundBody,
        response: {
          200: DataResponse(CampaignFundRoutingResponse),
          422: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const { id: campaignId, fundId } = request.params as { id: string; fundId: string };
      const patch = request.body as {
        splitPct?: string | null;
        isOnlineDefault?: boolean;
        sortOrder?: number;
      };

      try {
        const row = await updateCampaignFund(campaignId, fundId, orgId, patch);
        return { data: row };
      } catch (err) {
        if (err instanceof CampaignFundNotFoundError) {
          return reply.status(404).send(problemDetail(404, "Not Found", err.message));
        }
        if (err instanceof CampaignFundInvariantError) {
          return reply.status(422).send(problemDetail(422, "Unprocessable Entity", err.message));
        }
        throw err;
      }
    },
  );

  /** Remove a fund from a campaign's routing table */
  app.delete(
    "/campaigns/:id/funds/routing/:fundId",
    {
      preHandler: [
        requireFlag(FEATURE_FLAG_KEYS.DONATION_FUND_ROUTING),
        // These routes exist solely to rebind where a campaign's money settles,
        // so they carry the same blast radius as a bank-account mutation (B5):
        // org_admin + a fresh MFA step-up, unconditionally.
        requireOrgAdmin,
        requireBankMutationAcr(),
      ],
      schema: {
        tags: ["Campaigns", "Funds"],
        params: CampaignFundParams,
        response: {
          204: Type.Null(),
          422: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const { id: campaignId, fundId } = request.params as { id: string; fundId: string };

      try {
        await removeCampaignFund(campaignId, fundId, orgId);
        return reply.status(204).send();
      } catch (err) {
        if (err instanceof CampaignFundNotFoundError) {
          return reply.status(404).send(problemDetail(404, "Not Found", err.message));
        }
        if (err instanceof CampaignFundInvariantError) {
          return reply.status(422).send(problemDetail(422, "Unprocessable Entity", err.message));
        }
        throw err;
      }
    },
  );
}
