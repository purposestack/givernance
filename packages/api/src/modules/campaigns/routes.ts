/** Campaign routes — full CRUD, stats, ROI, document generation, and eligible funds */

import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import {
  buildCustomValidator,
  type CustomFieldPatch,
  type CustomFieldValues,
  type CustomValidator,
} from "@givernance/shared/custom-fields";
import {
  CAMPAIGN_STATUS_VALUES,
  CAMPAIGN_TYPE_VALUES,
  FUND_TYPE_VALUES,
} from "@givernance/shared/schema";
import { MULTI_CURRENCY_VALUES } from "@givernance/shared/validators";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { CustomFieldValidationError, customFieldsProblem } from "../../lib/custom-field-values.js";
import { flagService as defaultFlagService } from "../../lib/flags/flag-service.js";
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
  buildCustomSerializer,
  getActiveDefinitions,
  getReadableDefinitions,
} from "../customization/lib/value-service.js";
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

/** Free-form campaign description (Epic #274 follow-up). Soft-cap matches the validator. */
const CampaignDescriptionSchema = Type.Union([Type.Null(), Type.String({ maxLength: 2000 })]);

/**
 * Custom-field values on responses (Epic #539). Keys are org-defined so the
 * schema is a Record with a closed VALUE union — the strict-response firewall
 * is the definition-driven serializer in each handler, which only ever emits
 * keys present in the org's active registry (never the whole stored blob).
 */
const CustomValuesResponseSchema = Type.Record(
  Type.String(),
  Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Array(Type.String())]),
);

/** Merge-patch payload for `custom` — runtime-validated against the org registry. */
const CustomPatchBodySchema = Type.Record(Type.String(), Type.Unknown());

type CampaignCustomSerializer = (custom: unknown) => CustomFieldValues;

/**
 * Per-request serializer for the campaign's own custom values, or null when
 * `campaigns.custom_fields` is off. Recomputed per request — eligibility is
 * never baked into caches or SSR props (Epic #539 anti-goal #9).
 */
async function buildCampaignCustomSerializer(
  request: FastifyRequest,
  orgId: string,
  options?: {
    /** Detail read only: archived-definition values stay readable (docs/35). */
    includeArchived?: boolean;
  },
): Promise<CampaignCustomSerializer | null> {
  const flags = request.flagService ?? defaultFlagService;
  const enabled = await flags.isEnabled(FEATURE_FLAG_KEYS.CAMPAIGNS_CUSTOM_FIELDS, { orgId });
  if (!enabled) return null;
  const defs = options?.includeArchived
    ? await getReadableDefinitions(orgId, "campaign")
    : await getActiveDefinitions(orgId, "campaign");
  return buildCustomSerializer(defs);
}

/**
 * Strips the RAW `custom` blob off a service row and re-attaches it
 * serialized when the flag is on. Raw blobs must never reach the wire
 * (Epic #539 anti-goal #5).
 */
function shapeCampaignCustom<T extends { custom?: unknown }>(
  row: T,
  serializer: CampaignCustomSerializer | null,
) {
  const { custom: rawCustom, ...rest } = row;
  return { ...rest, ...(serializer ? { custom: serializer(rawCustom) } : {}) };
}

function customFieldsDisabledProblem() {
  return problemDetail(
    422,
    "custom_fields_disabled",
    "Custom fields on campaigns are not enabled for your organisation.",
  );
}

const customValidationProblem = customFieldsProblem;

type CampaignCustomWrite =
  | {
      ok: true;
      /** Create path only: pre-merged blob (there is no existing row to race). */
      merged: CustomFieldValues | undefined;
      /** Update path only: raw patch + validator — merged INSIDE the update tx. */
      patch: CustomFieldPatch | undefined;
      validator: CustomValidator | null;
      serializer: CampaignCustomSerializer | null;
    }
  | { ok: false; kind: "unprocessable"; problem: ReturnType<typeof problemDetail> };

/**
 * Resolves the `custom` merge-patch of a campaign write. Flag off + values
 * in the payload → 422 (multi-type precedent, issue #465: the core route
 * always works, the gated affordance is rejected loudly, never silently
 * dropped). Flag on → create path (`campaignId` absent) validates + merges
 * here against `{}` with `required` enforced; update path hands the raw
 * patch + validator down to the service, which merges over the FOR
 * UPDATE-locked current blob INSIDE the update transaction — reading the
 * blob here would let concurrent patches drop each other's keys.
 */
async function resolveCampaignCustomWrite(
  request: FastifyRequest,
  orgId: string,
  patch: Record<string, unknown> | undefined,
  campaignId?: string,
): Promise<CampaignCustomWrite> {
  const flags = request.flagService ?? defaultFlagService;
  const enabled = await flags.isEnabled(FEATURE_FLAG_KEYS.CAMPAIGNS_CUSTOM_FIELDS, { orgId });
  if (!enabled) {
    if (patch && Object.keys(patch).length > 0) {
      return { ok: false, kind: "unprocessable", problem: customFieldsDisabledProblem() };
    }
    return { ok: true, merged: undefined, patch: undefined, validator: null, serializer: null };
  }

  const defs = await getActiveDefinitions(orgId, "campaign");
  const serializer = buildCustomSerializer(defs);
  const validator = buildCustomValidator(defs);

  if (campaignId !== undefined) {
    return {
      ok: true,
      merged: undefined,
      patch: patch as CustomFieldPatch | undefined,
      validator,
      serializer,
    };
  }

  const result = validator.validatePatch({}, patch ?? {}, { enforceRequired: true });
  if (!result.ok) {
    return { ok: false, kind: "unprocessable", problem: customValidationProblem(result.errors) };
  }
  return { ok: true, merged: result.merged, patch: undefined, validator, serializer };
}

/**
 * Epic #318 — Swiss QR-bill picker on the campaign form. The optional
 * `bankAccountId` is a same-tenant FK pointing at `bank_accounts.id`;
 * setting it flips the campaign into Swiss QR-bill mode (the worker
 * appends a QR-bill PDF to every postal export). `qrReferenceMode`
 * lets the operator override the worker's auto-derivation (QRR for
 * QR-IBANs, SCOR for regular IBANs) on the rare bank that supports both.
 */
const CampaignQrReferenceModeSchema = Type.Union([
  Type.Literal("auto"),
  Type.Literal("qrr"),
  Type.Literal("scor"),
]);

const CampaignCreateBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 255 }),
  description: Type.Optional(CampaignDescriptionSchema),
  type: CampaignTypeSchema,
  defaultCurrency: Type.Optional(CampaignDefaultCurrencySchema),
  parentId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  operationalCostCents: Type.Optional(Type.Union([Type.Null(), Type.Integer({ minimum: 0 })])),
  goalAmountCents: Type.Optional(Type.Union([Type.Null(), Type.Integer({ minimum: 0 })])),
  fundIds: Type.Optional(Type.Array(UuidSchema)),
  bankAccountId: Type.Optional(Type.Union([Type.Null(), UuidSchema])),
  qrReferenceMode: Type.Optional(CampaignQrReferenceModeSchema),
  custom: Type.Optional(CustomPatchBodySchema),
});

const CampaignUpdateBody = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    description: Type.Optional(CampaignDescriptionSchema),
    type: Type.Optional(CampaignTypeSchema),
    defaultCurrency: Type.Optional(CampaignDefaultCurrencySchema),
    status: Type.Optional(
      Type.Union([Type.Literal("draft"), Type.Literal("active"), Type.Literal("closed")]),
    ),
    parentId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    operationalCostCents: Type.Optional(Type.Union([Type.Null(), Type.Integer({ minimum: 0 })])),
    goalAmountCents: Type.Optional(Type.Union([Type.Null(), Type.Integer({ minimum: 0 })])),
    fundIds: Type.Optional(Type.Array(UuidSchema)),
    bankAccountId: Type.Optional(Type.Union([Type.Null(), UuidSchema])),
    qrReferenceMode: Type.Optional(CampaignQrReferenceModeSchema),
    custom: Type.Optional(CustomPatchBodySchema),
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
  description: Type.Union([Type.Null(), Type.String()]),
  type: CampaignTypeSchema,
  status: CampaignStatusSchema,
  defaultCurrency: CampaignDefaultCurrencySchema,
  parentId: Type.Union([UuidSchema, Type.Null()]),
  operationalCostCents: Type.Union([Type.Integer(), Type.Null()]),
  platformFeesCents: Type.Integer(),
  goalAmountCents: Type.Union([Type.Integer(), Type.Null()]),
  /**
   * Epic #318: Swiss QR-bill discriminator. Presence IS the
   * "Swiss QR-bill mode on" signal — see ADR-027 / docs/25 §3.
   */
  bankAccountId: Type.Union([UuidSchema, Type.Null()]),
  qrReferenceMode: CampaignQrReferenceModeSchema,
  createdAt: Type.String(),
  updatedAt: Type.String(),
  /** Present only when `campaigns.custom_fields` is on; definition-filtered. */
  custom: Type.Optional(CustomValuesResponseSchema),
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
      // Serializer built ONCE per request (one cached catalog read, not
      // per-row lookups) and applied over the page slice — no N+1.
      const [result, serializer] = await Promise.all([
        listCampaigns(orgId, {
          page: query.page ?? 1,
          perPage: query.perPage ?? 20,
          search: query.search,
          status: query.status,
          sort: query.sort,
          order: query.order,
        }),
        buildCampaignCustomSerializer(request, orgId),
      ]);

      return {
        data: result.data.map((row) => shapeCampaignCustom(row, serializer)),
        pagination: result.pagination,
      };
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

      const userId = request.auth?.userId;
      const body = request.body as {
        name: string;
        description?: string | null;
        type: "nominative_postal" | "door_drop" | "digital";
        defaultCurrency?: "EUR" | "GBP" | "CHF";
        parentId?: string | null;
        operationalCostCents?: number | null;
        goalAmountCents?: number | null;
        fundIds?: string[];
        bankAccountId?: string | null;
        qrReferenceMode?: "auto" | "qrr" | "scor";
        custom?: Record<string, unknown>;
      };

      const customWrite = await resolveCampaignCustomWrite(request, orgId, body.custom);
      if (!customWrite.ok) {
        return reply.status(422).send(customWrite.problem);
      }

      try {
        const campaign = await createCampaign(
          orgId,
          { ...body, custom: customWrite.merged },
          userId,
          request,
        );
        if (!campaign) {
          return reply
            .status(404)
            .send(problemDetail(404, "Not Found", "Parent campaign not found"));
        }
        reply.header("Location", `/v1/campaigns/${campaign.id}`);
        return reply
          .status(201)
          .send({ data: shapeCampaignCustom(campaign, customWrite.serializer) });
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
      const [campaign, serializer] = await Promise.all([
        getCampaign(orgId, id),
        buildCampaignCustomSerializer(request, orgId, { includeArchived: true }),
      ]);

      if (!campaign) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Campaign not found"));
      }

      return { data: shapeCampaignCustom(campaign, serializer) };
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
          422: ProblemDetailSchema,
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
        description?: string | null;
        type?: "nominative_postal" | "door_drop" | "digital";
        defaultCurrency?: "EUR" | "GBP" | "CHF";
        status?: "draft" | "active" | "closed";
        parentId?: string | null;
        operationalCostCents?: number | null;
        goalAmountCents?: number | null;
        fundIds?: string[];
        bankAccountId?: string | null;
        qrReferenceMode?: "auto" | "qrr" | "scor";
        custom?: Record<string, unknown>;
      };

      if (body.status !== undefined && request.auth?.role !== "org_admin") {
        return reply
          .status(403)
          .send(
            problemDetail(403, "Forbidden", "Only an org admin can change a campaign's status."),
          );
      }

      const customWrite = await resolveCampaignCustomWrite(request, orgId, body.custom, id);
      if (!customWrite.ok) {
        return reply.status(422).send(customWrite.problem);
      }

      try {
        // The service validates + merges the patch over the FOR UPDATE-locked
        // current blob inside its transaction (concurrent-patch safety).
        const updated = await updateCampaign(
          orgId,
          id,
          { ...body, custom: customWrite.patch, customValidator: customWrite.validator },
          userId,
          request,
        );

        if (!updated) {
          return reply.status(404).send(problemDetail(404, "Not Found", "Campaign not found"));
        }

        return { data: shapeCampaignCustom(updated, customWrite.serializer) };
      } catch (err) {
        if (err instanceof CustomFieldValidationError) {
          return reply.status(422).send(customValidationProblem(err.errors));
        }
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
      const [closed, serializer] = await Promise.all([
        closeCampaign(orgId, id, userId, request),
        buildCampaignCustomSerializer(request, orgId),
      ]);

      if (!closed) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Campaign not found"));
      }

      return { data: shapeCampaignCustom(closed, serializer) };
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

      const result = await requestCampaignDocuments(orgId, userId, id, constituentIds, request);

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
}
