/** Campaign routes — full CRUD, stats, ROI, document generation, and eligible funds */

import { randomBytes } from "node:crypto";
import {
  CAMPAIGN_EXPORT_JOB_STATUS_VALUES,
  CAMPAIGN_EXPORT_MODE_VALUES,
  CAMPAIGN_STATUS_VALUES,
  CAMPAIGN_TYPE_VALUES,
  FUND_TYPE_VALUES,
} from "@givernance/shared/schema";
import { MULTI_CURRENCY_VALUES } from "@givernance/shared/validators";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { createCampaignLetterPdfStream } from "../../lib/campaign-pdf.js";
import { requireAuth, requireOrgAdmin, requireWrite } from "../../lib/guards.js";
import {
  DataArrayResponse,
  DataArrayResponseNoPagination,
  DataResponse,
  ErrorResponses,
  IdParams,
  PaginationQuery,
  ProblemDetailSchema,
  problemDetail,
  SortOrderSchema,
  UuidSchema,
} from "../../lib/schemas.js";
import {
  attachConstituents,
  CampaignLinkError,
  detachConstituent,
  listLinkedConstituents,
} from "./constituents-service.js";
import {
  createExportJob,
  ExportJobError,
  getExportJobView,
  listCampaignExportJobs,
} from "./exports-service.js";
import {
  CAMPAIGN_SORT_FIELDS,
  CampaignValidationError,
  closeCampaign,
  createCampaign,
  getCampaign,
  getCampaignRoi,
  getCampaignStats,
  listCampaignFunds,
  listCampaigns,
  requestCampaignDocuments,
  updateCampaign,
} from "./service.js";

/** Shared campaign type TypeBox union built from the canonical CAMPAIGN_TYPE_VALUES */
const CampaignTypeSchema = Type.Union(CAMPAIGN_TYPE_VALUES.map((v) => Type.Literal(v)));

/** Shared campaign status TypeBox union built from the canonical CAMPAIGN_STATUS_VALUES */
const CampaignStatusSchema = Type.Union(CAMPAIGN_STATUS_VALUES.map((v) => Type.Literal(v)));
const CampaignDefaultCurrencySchema = Type.Union(
  MULTI_CURRENCY_VALUES.map((value) => Type.Literal(value)),
);

/**
 * Idempotency-Key header schema.
 *
 * 24h TTL, scoped per-route and per-tenant. A duplicate in-flight request
 * with the same key returns 409 + `retry-after`. A key whose original
 * request already completed replays that response (including `Location`,
 * `ETag`, `Content-Type`, `retry-after` headers) with
 * `idempotency-replayed: true`. Body fingerprint is NOT verified — same key
 * with a different body replays the original response. Non-2xx responses
 * are not cached, so a 4xx retry re-runs the handler.
 */
const IdempotencyKeyHeader = Type.Object({
  "idempotency-key": Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 255,
      description:
        "Client-supplied idempotency key. Same key within 24h replays the first 2xx response. See plugins/idempotency.ts for semantics.",
    }),
  ),
});

const CampaignCreateBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 255 }),
  type: CampaignTypeSchema,
  defaultCurrency: Type.Optional(CampaignDefaultCurrencySchema),
  parentId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  operationalCostCents: Type.Optional(Type.Union([Type.Null(), Type.Integer({ minimum: 0 })])),
  goalAmountCents: Type.Optional(Type.Union([Type.Null(), Type.Integer({ minimum: 0 })])),
  fundIds: Type.Optional(Type.Array(UuidSchema)),
});

const CampaignUpdateBody = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    type: Type.Optional(CampaignTypeSchema),
    defaultCurrency: Type.Optional(CampaignDefaultCurrencySchema),
    status: Type.Optional(
      Type.Union([Type.Literal("draft"), Type.Literal("active"), Type.Literal("closed")]),
    ),
    parentId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    operationalCostCents: Type.Optional(Type.Union([Type.Null(), Type.Integer({ minimum: 0 })])),
    goalAmountCents: Type.Optional(Type.Union([Type.Null(), Type.Integer({ minimum: 0 })])),
    fundIds: Type.Optional(Type.Array(UuidSchema)),
  },
  { minProperties: 1 },
);

const DocumentsCreateBody = Type.Object({
  constituentIds: Type.Array(UuidSchema, { default: [] }),
});

const CampaignResponse = Type.Object({
  id: UuidSchema,
  orgId: UuidSchema,
  name: Type.String(),
  type: CampaignTypeSchema,
  status: CampaignStatusSchema,
  defaultCurrency: CampaignDefaultCurrencySchema,
  parentId: Type.Union([UuidSchema, Type.Null()]),
  operationalCostCents: Type.Union([Type.Integer(), Type.Null()]),
  platformFeesCents: Type.Integer(),
  goalAmountCents: Type.Union([Type.Integer(), Type.Null()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

const FundTypeSchema = Type.Union(FUND_TYPE_VALUES.map((value) => Type.Literal(value)));

const CampaignFundResponse = Type.Object({
  id: UuidSchema,
  orgId: UuidSchema,
  name: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  type: FundTypeSchema,
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

const DocumentsResult = Type.Object({
  campaignId: UuidSchema,
  documentCount: Type.Integer(),
});

const CampaignStatsResponse = Type.Object({
  campaignId: UuidSchema,
  totalRaisedCents: Type.Integer(),
  donationCount: Type.Integer(),
  uniqueDonors: Type.Integer(),
});

const CampaignRoiResponse = Type.Object({
  campaignId: UuidSchema,
  rawGoalCents: Type.Union([Type.Integer(), Type.Null()]),
  rawRaisedCents: Type.Integer(),
  rawPlatformFeesCents: Type.Integer(),
  rawOperationalCostCents: Type.Union([Type.Integer(), Type.Null()]),
  totalCostCents: Type.Integer(),
  roiPct: Type.Union([Type.Number(), Type.Null()]),
});

/**
 * Server-side sort fields whitelist for `GET /campaigns`. Single source
 * of truth lives in `./service.ts` (issue #218).
 */
const CampaignSortFieldSchema = Type.Union(
  CAMPAIGN_SORT_FIELDS.map((field) => Type.Literal(field)),
);

const ListQuery = Type.Intersect([
  PaginationQuery,
  Type.Object({
    search: Type.Optional(Type.String({ maxLength: 200 })),
    status: Type.Optional(CampaignStatusSchema),
    sort: Type.Optional(CampaignSortFieldSchema),
    order: Type.Optional(SortOrderSchema),
  }),
]);

export async function campaignRoutes(app: FastifyInstance) {
  /** List campaigns with pagination */
  app.get(
    "/campaigns",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Campaigns"],
        querystring: ListQuery,
        response: { 200: DataArrayResponse(CampaignResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const query = request.query as {
        page?: number;
        perPage?: number;
        search?: string;
        status?: "draft" | "active" | "closed";
        sort?: (typeof CAMPAIGN_SORT_FIELDS)[number];
        order?: "asc" | "desc";
      };
      const result = await listCampaigns(orgId, {
        page: query.page ?? 1,
        perPage: query.perPage ?? 20,
        search: query.search,
        status: query.status,
        sort: query.sort,
        order: query.order,
      });

      return { data: result.data, pagination: result.pagination };
    },
  );

  /** Create a new campaign */
  app.post(
    "/campaigns",
    {
      // Issue #181: `minRole` mirrors `requireWrite` so the idempotency
      // replay branch enforces the same role check the guard would.
      config: { idempotency: { routeKey: "POST:/v1/campaigns", minRole: "write" } },
      preHandler: requireWrite,
      schema: {
        tags: ["Campaigns"],
        body: CampaignCreateBody,
        headers: IdempotencyKeyHeader,
        response: {
          201: DataResponse(CampaignResponse),
          400: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const userId = request.auth?.userId;
      const body = request.body as {
        name: string;
        type: "nominative_postal" | "door_drop" | "digital";
        defaultCurrency?: "EUR" | "GBP" | "CHF";
        parentId?: string | null;
        operationalCostCents?: number | null;
        goalAmountCents?: number | null;
        fundIds?: string[];
      };
      try {
        const campaign = await createCampaign(orgId, body, userId);
        if (!campaign) {
          return reply
            .status(404)
            .send(problemDetail(404, "Not Found", "Parent campaign not found"));
        }
        reply.header("Location", `/v1/campaigns/${campaign.id}`);
        return reply.status(201).send({ data: campaign });
      } catch (err) {
        if (err instanceof CampaignValidationError) {
          return reply.status(400).send(problemDetail(400, "Bad Request", err.message));
        }
        throw err;
      }
    },
  );

  /** Get a single campaign by ID */
  app.get(
    "/campaigns/:id",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Campaigns"],
        params: IdParams,
        response: { 200: DataResponse(CampaignResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const { id } = request.params as { id: string };
      const campaign = await getCampaign(orgId, id);

      if (!campaign) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Campaign not found"));
      }

      return { data: campaign };
    },
  );

  /**
   * Update a campaign (partial update).
   *
   * Operational fields (`name`, `type`, `defaultCurrency`, `parentId`,
   * `operationalCostCents`, `fundIds`) are write-tier — `org_admin` AND
   * `user` can edit them, mirroring the create endpoint's gate.
   *
   * `status` transitions stay admin-only (the StatusActions buttons in
   * the web detail card are already hidden for non-admins). We enforce
   * that here at the field level: if the body contains `status` and the
   * caller isn't `org_admin`, return 403 — anyone bypassing the UI to
   * call PATCH directly hits the same wall as the dedicated close endpoint.
   */
  app.patch(
    "/campaigns/:id",
    {
      preHandler: requireWrite,
      schema: {
        tags: ["Campaigns"],
        params: IdParams,
        body: CampaignUpdateBody,
        response: {
          200: DataResponse(CampaignResponse),
          400: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      const userId = request.auth?.userId;
      if (!orgId || !userId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const { id } = request.params as { id: string };
      const body = request.body as {
        name?: string;
        type?: "nominative_postal" | "door_drop" | "digital";
        defaultCurrency?: "EUR" | "GBP" | "CHF";
        status?: "draft" | "active" | "closed";
        parentId?: string | null;
        operationalCostCents?: number | null;
        goalAmountCents?: number | null;
        fundIds?: string[];
      };

      if (body.status !== undefined && request.auth?.role !== "org_admin") {
        return reply
          .status(403)
          .send(
            problemDetail(403, "Forbidden", "Only an org admin can change a campaign's status."),
          );
      }

      try {
        const updated = await updateCampaign(orgId, id, body, userId);

        if (!updated) {
          return reply.status(404).send(problemDetail(404, "Not Found", "Campaign not found"));
        }

        return { data: updated };
      } catch (err) {
        if (err instanceof CampaignValidationError) {
          return reply.status(400).send(problemDetail(400, "Bad Request", err.message));
        }
        throw err;
      }
    },
  );

  /** List funds eligible for a campaign */
  app.get(
    "/campaigns/:id/funds",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Campaigns"],
        params: IdParams,
        response: { 200: DataArrayResponseNoPagination(CampaignFundResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const { id } = request.params as { id: string };
      const funds = await listCampaignFunds(orgId, id);

      if (!funds) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Campaign not found"));
      }

      return { data: funds };
    },
  );

  /** Close a campaign (soft delete — sets status to 'closed') */
  app.post(
    "/campaigns/:id/close",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Campaigns"],
        params: IdParams,
        response: { 200: DataResponse(CampaignResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      const userId = request.auth?.userId;
      if (!orgId || !userId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const { id } = request.params as { id: string };
      const closed = await closeCampaign(orgId, id, userId);

      if (!closed) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Campaign not found"));
      }

      return { data: closed };
    },
  );

  /** Get campaign stats: total raised, donation count, unique donors */
  app.get(
    "/campaigns/:id/stats",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Campaigns"],
        params: IdParams,
        response: { 200: DataResponse(CampaignStatsResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const { id } = request.params as { id: string };
      const stats = await getCampaignStats(orgId, id);

      if (!stats) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Campaign not found"));
      }

      return { data: stats };
    },
  );

  /** Get campaign ROI read-model */
  app.get(
    "/campaigns/:id/roi",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Campaigns"],
        params: IdParams,
        response: { 200: DataResponse(CampaignRoiResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const { id } = request.params as { id: string };
      const roi = await getCampaignRoi(orgId, id);

      if (!roi) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Campaign not found"));
      }

      return { data: roi };
    },
  );

  /** Trigger batch document generation for a campaign */
  app.post(
    "/campaigns/:id/documents",
    {
      // Issue #181: `minRole: admin` mirrors `requireOrgAdmin` so the
      // idempotency replay branch enforces the same role check the guard
      // would (this route is the only `requireOrgAdmin`-gated idempotent
      // POST in the codebase today).
      config: {
        idempotency: { routeKey: "POST:/v1/campaigns/:id/documents", minRole: "admin" },
      },
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Campaigns"],
        params: IdParams,
        body: DocumentsCreateBody,
        headers: IdempotencyKeyHeader,
        response: { 202: DataResponse(DocumentsResult), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      const userId = request.auth?.userId;
      if (!orgId || !userId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const { id } = request.params as { id: string };
      const { constituentIds } = request.body as { constituentIds: string[] };

      const result = await requestCampaignDocuments(orgId, userId, id, constituentIds);

      if (!result) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Campaign not found"));
      }

      // `Location` points clients at the polling resource for this job — they
      // can GET the campaign to watch document statuses move from "pending"
      // to "generated". Issue #56 API minor.
      reply.header("Location", `/v1/campaigns/${id}`);
      return reply.status(202).send({ data: result });
    },
  );

  // ── Epic #274 — Constituent linking, ZIP exports, preview ────────────────

  const LinkedConstituentRow = Type.Object({
    id: UuidSchema,
    constituentId: UuidSchema,
    firstName: Type.String(),
    lastName: Type.String(),
    email: Type.Union([Type.Null(), Type.String()]),
    type: Type.String(),
    addedByUserId: Type.Union([Type.Null(), UuidSchema]),
    createdAt: Type.String(),
    reconciledAmountCents: Type.Integer(),
    reconciledDonationCount: Type.Integer(),
  });

  const LinkConstituentsBody = Type.Object({
    constituentIds: Type.Array(UuidSchema, { minItems: 1, maxItems: 1000 }),
  });

  const LinkConstituentsResult = Type.Object({
    attached: Type.Integer(),
    skipped: Type.Integer(),
  });

  const CampaignExportModeSchema = Type.Union(
    CAMPAIGN_EXPORT_MODE_VALUES.map((v) => Type.Literal(v)),
  );

  const CampaignExportJobStatusSchema = Type.Union(
    CAMPAIGN_EXPORT_JOB_STATUS_VALUES.map((v) => Type.Literal(v)),
  );

  const CampaignExportJobResponse = Type.Object({
    id: UuidSchema,
    orgId: UuidSchema,
    campaignId: UuidSchema,
    mode: CampaignExportModeSchema,
    status: CampaignExportJobStatusSchema,
    progressTotal: Type.Integer(),
    progressDone: Type.Integer(),
    progressPct: Type.Integer(),
    archiveS3Path: Type.Union([Type.Null(), Type.String()]),
    downloadUrl: Type.Optional(Type.Union([Type.Null(), Type.String()])),
    error: Type.Union([Type.Null(), Type.String()]),
    startedAt: Type.Union([Type.Null(), Type.String()]),
    completedAt: Type.Union([Type.Null(), Type.String()]),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  });

  const CreateExportBody = Type.Object({
    mode: CampaignExportModeSchema,
  });

  /** GET /campaigns/:id/constituents — list linked recipients */
  app.get(
    "/campaigns/:id/constituents",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Campaigns"],
        params: IdParams,
        querystring: Type.Intersect([
          PaginationQuery,
          Type.Object({ search: Type.Optional(Type.String({ maxLength: 200 })) }),
        ]),
        response: {
          200: Type.Object({
            data: Type.Array(LinkedConstituentRow),
            pagination: Type.Object({
              page: Type.Integer(),
              perPage: Type.Integer(),
              total: Type.Integer(),
              totalPages: Type.Integer(),
            }),
            campaignType: Type.Union(CAMPAIGN_TYPE_VALUES.map((v) => Type.Literal(v))),
          }),
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
      const query = request.query as { page?: number; perPage?: number; search?: string };
      try {
        const result = await listLinkedConstituents(orgId, id, {
          page: query.page ?? 1,
          perPage: query.perPage ?? 50,
          search: query.search,
        });
        return result;
      } catch (err) {
        if (err instanceof CampaignLinkError && err.code === "campaign_not_found") {
          return reply.status(404).send(problemDetail(404, "Not Found", "Campaign not found"));
        }
        throw err;
      }
    },
  );

  /** POST /campaigns/:id/constituents — attach a list of recipients */
  app.post(
    "/campaigns/:id/constituents",
    {
      preHandler: requireWrite,
      schema: {
        tags: ["Campaigns"],
        params: IdParams,
        body: LinkConstituentsBody,
        response: {
          200: DataResponse(LinkConstituentsResult),
          400: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      const userId = request.auth?.userId;
      if (!orgId || !userId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const { id } = request.params as { id: string };
      const { constituentIds } = request.body as { constituentIds: string[] };
      try {
        const result = await attachConstituents(orgId, id, constituentIds, userId);
        return { data: result };
      } catch (err) {
        if (err instanceof CampaignLinkError) {
          const status = err.code === "campaign_not_found" ? 404 : 400;
          return reply.status(status).send(problemDetail(status, err.code, err.message));
        }
        throw err;
      }
    },
  );

  /** DELETE /campaigns/:id/constituents/:constituentId — detach a recipient */
  app.delete(
    "/campaigns/:id/constituents/:constituentId",
    {
      preHandler: requireWrite,
      schema: {
        tags: ["Campaigns"],
        params: Type.Object({ id: UuidSchema, constituentId: UuidSchema }),
        response: {
          204: Type.Any(),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      const userId = request.auth?.userId;
      if (!orgId || !userId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const { id, constituentId } = request.params as { id: string; constituentId: string };
      const ok = await detachConstituent(orgId, id, constituentId, userId);
      if (!ok) {
        return reply
          .status(404)
          .send(problemDetail(404, "Not Found", "Constituent not linked to this campaign"));
      }
      return reply.status(204).send();
    },
  );

  /** POST /campaigns/:id/exports — start an asynchronous ZIP export */
  app.post(
    "/campaigns/:id/exports",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Campaigns"],
        params: IdParams,
        body: CreateExportBody,
        response: {
          202: DataResponse(CampaignExportJobResponse),
          400: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      const userId = request.auth?.userId;
      if (!orgId || !userId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const { id } = request.params as { id: string };
      const { mode } = request.body as { mode: "door_drop" | "nominative" };
      try {
        const job = await createExportJob(orgId, id, mode, userId);
        reply.header("Location", `/v1/campaigns/${id}/exports/${job.id}`);
        return reply.status(202).send({
          data: {
            ...job,
            createdAt: job.createdAt.toISOString(),
            updatedAt: job.updatedAt.toISOString(),
            startedAt: job.startedAt?.toISOString() ?? null,
            completedAt: job.completedAt?.toISOString() ?? null,
            progressPct: 0,
            downloadUrl: null,
          },
        });
      } catch (err) {
        if (err instanceof ExportJobError) {
          const status = err.code === "campaign_not_found" ? 404 : 400;
          return reply.status(status).send(problemDetail(status, err.code, err.message));
        }
        throw err;
      }
    },
  );

  /** GET /campaigns/:id/exports — list recent export jobs */
  app.get(
    "/campaigns/:id/exports",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Campaigns"],
        params: IdParams,
        response: {
          200: DataArrayResponseNoPagination(CampaignExportJobResponse),
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
      const jobs = await listCampaignExportJobs(orgId, id);
      return {
        data: jobs.map((job) => ({
          ...job,
          createdAt: job.createdAt.toISOString(),
          updatedAt: job.updatedAt.toISOString(),
          startedAt: job.startedAt?.toISOString() ?? null,
          completedAt: job.completedAt?.toISOString() ?? null,
          progressPct:
            job.status === "completed"
              ? 100
              : job.progressTotal > 0
                ? Math.min(100, Math.floor((job.progressDone / job.progressTotal) * 100))
                : 0,
          downloadUrl: null,
        })),
      };
    },
  );

  /** GET /campaigns/:id/exports/:jobId — poll job status (with signed download URL) */
  app.get(
    "/campaigns/:id/exports/:jobId",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Campaigns"],
        params: Type.Object({ id: UuidSchema, jobId: UuidSchema }),
        response: {
          200: DataResponse(CampaignExportJobResponse),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const { id, jobId } = request.params as { id: string; jobId: string };
      const view = await getExportJobView(orgId, id, jobId);
      if (!view) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Export job not found"));
      }
      return {
        data: {
          ...view,
          createdAt: view.createdAt.toISOString(),
          updatedAt: view.updatedAt.toISOString(),
          startedAt: view.startedAt?.toISOString() ?? null,
          completedAt: view.completedAt?.toISOString() ?? null,
        },
      };
    },
  );

  /**
   * GET /campaigns/:id/preview-pdf — synchronous unitary preview with fake
   * data ("Jean Dupont"). No DB writes, no QR persistence — the QR payload
   * is a randomly generated placeholder that is NOT registered, so a scan
   * would resolve to 404. The endpoint exists purely to validate the
   * letter layout before kicking off a mass export.
   */
  app.get(
    "/campaigns/:id/preview-pdf",
    {
      preHandler: requireWrite,
      schema: {
        tags: ["Campaigns"],
        params: IdParams,
        querystring: Type.Object({
          mode: Type.Optional(CampaignExportModeSchema),
        }),
        response: { ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const { id } = request.params as { id: string };
      const { mode } = request.query as { mode?: "door_drop" | "nominative" };

      const campaign = await getCampaign(orgId, id);
      if (!campaign) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Campaign not found"));
      }

      const effectiveMode: "door_drop" | "nominative" =
        mode ?? (campaign.type === "door_drop" ? "door_drop" : "nominative");

      const stream = await createCampaignLetterPdfStream({
        campaignName: campaign.name,
        qrPayload: `preview-${randomBytes(8).toString("base64url")}`,
        constituent:
          effectiveMode === "door_drop"
            ? null
            : { firstName: "Jean", lastName: "Dupont", email: "jean.dupont@example.org" },
      });

      reply.header("Content-Type", "application/pdf");
      reply.header("Content-Disposition", `inline; filename="campaign-${campaign.id}-preview.pdf"`);
      return reply.send(stream);
    },
  );
}
