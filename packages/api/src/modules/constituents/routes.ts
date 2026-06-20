/** Constituent routes — full CRUD with search, filtering, and soft-delete */

import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireFlag } from "../../lib/flags/flag-guard.js";
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
  BulkEmailResumeError,
  BulkEmailValidationError,
  dispatchBulkEmail,
  getBulkEmailJob,
  listBulkEmailJobs,
  resumeBulkEmailJob,
} from "./bulk-email-service.js";
import { registerBulkImportRoutes } from "./bulk-import/routes.js";
import { registerFilterEndpoints } from "./filters/filter.routes.js";
import {
  CONSTITUENT_SORT_FIELDS,
  createConstituent,
  deleteConstituent,
  findDuplicates,
  getConstituent,
  listConstituents,
  MergePreconditionError,
  mergeConstituents,
  updateConstituent,
} from "./service.js";

const ConstituentTypeEnum = Type.Union([
  Type.Literal("donor"),
  Type.Literal("volunteer"),
  Type.Literal("member"),
  Type.Literal("beneficiary"),
  Type.Literal("partner"),
]);

/**
 * Canonical multi-valued type (issue #465). At least one, no duplicates. The
 * handler rejects more than one element when the `constituents.multi_type`
 * flag is off for the tenant (`multi_type_disabled`).
 */
const ConstituentTypesArray = Type.Array(ConstituentTypeEnum, {
  minItems: 1,
  uniqueItems: true,
});

/**
 * Postal address fields (Epic #274 follow-up). All five are independent
 * and nullable — the constituent form lets the operator opt in per
 * recipient; the renderer skips the window-envelope address block when
 * any required line is missing.
 *
 * Null variants come FIRST in every nullable Union for the same ajv
 * `coerceTypes` pitfall described above on `email` / `phone`.
 */
const ConstituentAddressCreateFields = {
  addressLine1: Type.Optional(Type.String({ maxLength: 255 })),
  addressLine2: Type.Optional(Type.String({ maxLength: 255 })),
  postalCode: Type.Optional(Type.String({ maxLength: 20 })),
  city: Type.Optional(Type.String({ maxLength: 255 })),
  countryCode: Type.Optional(Type.String({ minLength: 2, maxLength: 2 })),
};

const ConstituentAddressUpdateFields = {
  addressLine1: Type.Optional(Type.Union([Type.Null(), Type.String({ maxLength: 255 })])),
  addressLine2: Type.Optional(Type.Union([Type.Null(), Type.String({ maxLength: 255 })])),
  postalCode: Type.Optional(Type.Union([Type.Null(), Type.String({ maxLength: 20 })])),
  city: Type.Optional(Type.Union([Type.Null(), Type.String({ maxLength: 255 })])),
  countryCode: Type.Optional(
    Type.Union([Type.Null(), Type.String({ minLength: 2, maxLength: 2 })]),
  ),
};

const ConstituentCreateBody = Type.Object({
  firstName: Type.String({ minLength: 1, maxLength: 255 }),
  lastName: Type.String({ minLength: 1, maxLength: 255 }),
  email: Type.Optional(Type.String({ maxLength: 255 })),
  phone: Type.Optional(Type.String({ maxLength: 50 })),
  ...ConstituentAddressCreateFields,
  // Canonical multi-valued type (issue #465). Defaults to ["donor"] in the
  // service when omitted. `type` (singular) stays accepted for back-compat.
  types: Type.Optional(ConstituentTypesArray),
  type: Type.Optional(ConstituentTypeEnum),
  tags: Type.Optional(Type.Array(Type.String())),
});

// Per the convention in @givernance/shared validators: optional fields accept
// `null` on UPDATE to mean "clear this field to NULL in the DB" (vs omitted =
// "leave alone"). Without this distinction the form has no way to express
// "remove the phone number from this constituent" — the client drops empty
// fields to avoid clobbering, and the API never sees them.
//
// Null variants come FIRST in every nullable Union — Fastify's ajv has
// `coerceTypes: true` by default and will silently coerce a runtime `null`
// to `""` if the first schema in the Union is `Type.String()`. With Null
// first, ajv recognises the value as already-valid and leaves it alone.
const ConstituentUpdateBody = Type.Object(
  {
    firstName: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    lastName: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    email: Type.Optional(Type.Union([Type.Null(), Type.String({ maxLength: 255 })])),
    phone: Type.Optional(Type.Union([Type.Null(), Type.String({ maxLength: 50 })])),
    ...ConstituentAddressUpdateFields,
    // Issue #465 — omitted = leave types untouched; present = replace the set.
    types: Type.Optional(ConstituentTypesArray),
    type: Type.Optional(ConstituentTypeEnum),
    tags: Type.Optional(Type.Array(Type.String())),
  },
  { minProperties: 1 },
);

/**
 * Server-side sort fields whitelist for `GET /constituents`. Single
 * source of truth lives in `./service.ts` (issue #218).
 */
const ConstituentSortFieldSchema = Type.Union(
  CONSTITUENT_SORT_FIELDS.map((field) => Type.Literal(field)),
);

const ListQuery = Type.Intersect([
  PaginationQuery,
  Type.Object({
    search: Type.Optional(Type.String({ maxLength: 200 })),
    tags: Type.Optional(Type.Union([Type.Array(Type.String()), Type.String()])),
    // Legacy single-value filter (kept) + multi-value filter (issue #465).
    // Both compile to an array-overlap against `types` in the service.
    type: Type.Optional(ConstituentTypeEnum),
    types: Type.Optional(Type.Union([Type.Array(ConstituentTypeEnum), ConstituentTypeEnum])),
    includeDeleted: Type.Optional(Type.Boolean({ default: false })),
    sort: Type.Optional(ConstituentSortFieldSchema),
    order: Type.Optional(SortOrderSchema),
    /**
     * Epic #274 — restrict to constituents linked to a specific campaign
     * via `campaign_constituents`.
     */
    campaignId: Type.Optional(UuidSchema),
    /**
     * Inverse of `campaignId` — exclude constituents already linked to this
     * campaign. Powers the "Add constituents" picker so it only offers people
     * not yet on the mailing list.
     */
    excludeCampaignId: Type.Optional(UuidSchema),
    /** ISO-8601 date — `MAX(donations.donatedAt) >= lastDonationFrom`. */
    lastDonationFrom: Type.Optional(Type.String({ format: "date-time" })),
    /** ISO-8601 date — `MAX(donations.donatedAt) <= lastDonationTo`. */
    lastDonationTo: Type.Optional(Type.String({ format: "date-time" })),
    /** Lifetime cleared-minus-refunded base cents (lower bound). */
    minLifetimeAmountCents: Type.Optional(Type.Integer({ minimum: 0 })),
    /** Lifetime cleared-minus-refunded base cents (upper bound). */
    maxLifetimeAmountCents: Type.Optional(Type.Integer({ minimum: 0 })),
  }),
]);

const DuplicateSearchQuery = Type.Object({
  firstName: Type.String({ minLength: 1, maxLength: 255 }),
  lastName: Type.String({ minLength: 1, maxLength: 255 }),
  email: Type.Optional(Type.String({ maxLength: 255 })),
});

const CreateQuery = Type.Object({
  force: Type.Optional(Type.Boolean({ default: false })),
});

const MergeBody = Type.Object({
  targetId: UuidSchema,
});

/**
 * Constituent shape returned by the API.
 *
 * Null variants come FIRST in every nullable Union — fast-json-stringify
 * (Fastify's response serializer) walks `oneOf` in declaration order and
 * coerces values to the first compatible schema. With `Type.String()` first,
 * a runtime `null` from a NULL DB column would be coerced to `""` in the
 * JSON output, breaking nullable semantics for clients (the constituent
 * edit form's "clear phone" path returns null from the service but the
 * client sees an empty string in the response).
 */
const ConstituentResponse = Type.Object({
  id: UuidSchema,
  orgId: UuidSchema,
  firstName: Type.String(),
  lastName: Type.String(),
  email: Type.Union([Type.Null(), Type.String()]),
  phone: Type.Union([Type.Null(), Type.String()]),
  // Postal address fields (Epic #274 follow-up). `Type.Optional` so legacy
  // INSERT...RETURNING paths that don't include the columns still serialise
  // — same defensive pattern as `tenants.mission` (cf. tenants/routes.ts).
  addressLine1: Type.Optional(Type.Union([Type.Null(), Type.String()])),
  addressLine2: Type.Optional(Type.Union([Type.Null(), Type.String()])),
  postalCode: Type.Optional(Type.Union([Type.Null(), Type.String()])),
  city: Type.Optional(Type.Union([Type.Null(), Type.String()])),
  countryCode: Type.Optional(Type.Union([Type.Null(), Type.String()])),
  // Canonical multi-valued type (issue #465). `type` (singular) is retained
  // as a deprecated back-compat mirror equal to `types[0]`.
  types: Type.Array(Type.String()),
  type: Type.String(),
  tags: Type.Union([Type.Null(), Type.Array(Type.String())]),
  deletedAt: Type.Union([Type.Null(), Type.String()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  activities: Type.Optional(Type.Array(Type.Unknown())),
});

/**
 * List-only row shape: `ConstituentResponse` + `lastDonationAt` (issue
 * #215). The detail endpoint (`GET /v1/constituents/:id`) doesn't compute
 * the aggregate, so the field lives on the list row only — modeling it
 * here means TypeBox response validation drops the field from any other
 * route's payload, even if a future refactor accidentally projects it.
 */
const ConstituentListRow = Type.Composite([
  ConstituentResponse,
  Type.Object({
    lastDonationAt: Type.Union([Type.Null(), Type.String()]),
  }),
]);

const DuplicateResponse = Type.Object({
  id: UuidSchema,
  firstName: Type.String(),
  lastName: Type.String(),
  email: Type.Union([Type.String(), Type.Null()]),
  score: Type.Number(),
});

const ConflictResponse = Type.Intersect([
  ProblemDetailSchema,
  Type.Object({ duplicates: Type.Array(DuplicateResponse) }),
]);

const MergeResult = Type.Object({ merged: Type.Boolean(), etag: Type.String() });

const MergeHeaders = Type.Object({
  "if-match": Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
});

const BulkEmailJobStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("processing"),
  Type.Literal("completed"),
  Type.Literal("partial"),
  Type.Literal("failed"),
]);

const BulkEmailJobRowSchema = Type.Object({
  id: UuidSchema,
  status: BulkEmailJobStatusSchema,
  subject: Type.String(),
  stalled: Type.Boolean(),
  totalRecipients: Type.Integer(),
  deliveredCount: Type.Integer(),
  failedCount: Type.Integer(),
  requestedBy: Type.Union([Type.Null(), UuidSchema]),
  parentJobId: Type.Union([Type.Null(), UuidSchema]),
  error: Type.Union([Type.Null(), Type.String()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  completedAt: Type.Union([Type.Null(), Type.String()]),
});

/**
 * Multi-type gate (issue #465). With `constituents.multi_type` OFF for the
 * tenant, a constituent may hold at most one type — preserving the legacy
 * single-picklist behaviour. A single-element `types` (or the legacy singular
 * `type`) is always allowed; only a payload trying to set ≥2 types is
 * rejected. Returns an RFC 9457 problem to send (422) or null when allowed.
 *
 * The flag is NOT a `requireFlag` preHandler here: the create/update routes
 * are core CRUD that must always work — only the *multi-valued affordance* is
 * gated, not the endpoint.
 */
async function rejectMultiTypeWhenDisabled(
  request: FastifyRequest,
  orgId: string,
  types: string[] | undefined,
) {
  if (!types || types.length <= 1) return null;
  const flags = request.flagService ?? defaultFlagService;
  const enabled = await flags.isEnabled(FEATURE_FLAG_KEYS.CONSTITUENTS_MULTI_TYPE, { orgId });
  if (enabled) return null;
  return problemDetail(
    422,
    "multi_type_disabled",
    "Assigning more than one type to a constituent requires the multi-type feature, which is not enabled for your organisation.",
  );
}

export async function constituentRoutes(app: FastifyInstance) {
  /** List constituents with pagination, search, and filtering */
  app.get(
    "/constituents",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Constituents"],
        querystring: ListQuery,
        response: { 200: DataArrayResponse(ConstituentListRow), ...ErrorResponses },
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
        tags?: string[] | string;
        type?: string;
        types?: string[] | string;
        includeDeleted?: boolean;
        sort?: (typeof CONSTITUENT_SORT_FIELDS)[number];
        order?: "asc" | "desc";
        campaignId?: string;
        excludeCampaignId?: string;
        lastDonationFrom?: string;
        lastDonationTo?: string;
        minLifetimeAmountCents?: number;
        maxLifetimeAmountCents?: number;
      };

      const tags = query.tags ? (Array.isArray(query.tags) ? query.tags : [query.tags]) : undefined;
      // `?types=donor&types=volunteer` arrives as an array; `?types=donor` as
      // a scalar — normalise to an array for the service's overlap filter.
      const types = query.types
        ? Array.isArray(query.types)
          ? query.types
          : [query.types]
        : undefined;

      const result = await listConstituents(orgId, {
        page: query.page ?? 1,
        perPage: query.perPage ?? 20,
        search: query.search,
        tags,
        type: query.type,
        types,
        includeDeleted: query.includeDeleted,
        sort: query.sort,
        order: query.order,
        campaignId: query.campaignId,
        excludeCampaignId: query.excludeCampaignId,
        lastDonationFrom: query.lastDonationFrom,
        lastDonationTo: query.lastDonationTo,
        minLifetimeAmountCents: query.minLifetimeAmountCents,
        maxLifetimeAmountCents: query.maxLifetimeAmountCents,
      });

      return { data: result.data, pagination: result.pagination };
    },
  );

  /** Get a single constituent by ID */
  app.get(
    "/constituents/:id",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Constituents"],
        params: IdParams,
        response: { 200: DataResponse(ConstituentResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const { id } = request.params as { id: string };
      const constituent = await getConstituent(orgId, id);

      if (!constituent) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Constituent not found"));
      }

      return { data: constituent };
    },
  );

  /**
   * Search for potential duplicate constituents.
   *
   * Gated to write-capable roles even though the verb is GET: the endpoint is
   * a pre-flight to `POST /v1/constituents`, not a general directory lookup.
   * Surfacing fuzzy-matched PII (name + email) to a `viewer` who can never
   * complete the create flow has no use case, so we treat it as a soft-PII
   * leak and require `requireWrite`.
   */
  app.get(
    "/constituents/duplicates/search",
    {
      preHandler: requireWrite,
      schema: {
        tags: ["Constituents"],
        querystring: DuplicateSearchQuery,
        response: {
          200: DataArrayResponseNoPagination(DuplicateResponse),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const query = request.query as { firstName: string; lastName: string; email?: string };
      const duplicates = await findDuplicates(orgId, query);
      return { data: duplicates };
    },
  );

  /** Create a new constituent (with duplicate pre-check unless force=true) */
  app.post(
    "/constituents",
    {
      preHandler: requireWrite,
      schema: {
        tags: ["Constituents"],
        body: ConstituentCreateBody,
        querystring: CreateQuery,
        response: {
          201: DataResponse(ConstituentResponse),
          409: ConflictResponse,
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

      const body = request.body as {
        firstName: string;
        lastName: string;
        email?: string;
        phone?: string;
        addressLine1?: string;
        addressLine2?: string;
        postalCode?: string;
        city?: string;
        countryCode?: string;
        types?: string[];
        type?: string;
        tags?: string[];
      };
      const query = request.query as { force?: boolean };

      const multiTypeError = await rejectMultiTypeWhenDisabled(request, orgId, body.types);
      if (multiTypeError) {
        return reply.status(422).send(multiTypeError);
      }

      if (!query.force) {
        const duplicates = await findDuplicates(orgId, {
          firstName: body.firstName,
          lastName: body.lastName,
          email: body.email,
        });
        if (duplicates.length > 0) {
          return reply.status(409).send({
            ...problemDetail(409, "Conflict", "Potential duplicate constituents found"),
            duplicates,
          });
        }
      }

      const constituent = await createConstituent(orgId, body);
      if (constituent) {
        reply.header("Location", `/v1/constituents/${constituent.id}`);
      }
      return reply.status(201).send({ data: constituent });
    },
  );

  /** Update a constituent (partial update) */
  app.put(
    "/constituents/:id",
    {
      preHandler: requireWrite,
      schema: {
        tags: ["Constituents"],
        params: IdParams,
        body: ConstituentUpdateBody,
        response: {
          200: DataResponse(ConstituentResponse),
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
        firstName?: string;
        lastName?: string;
        email?: string | null;
        phone?: string | null;
        addressLine1?: string | null;
        addressLine2?: string | null;
        postalCode?: string | null;
        city?: string | null;
        countryCode?: string | null;
        types?: string[];
        type?: string;
        tags?: string[];
      };

      const multiTypeError = await rejectMultiTypeWhenDisabled(request, orgId, body.types);
      if (multiTypeError) {
        return reply.status(422).send(multiTypeError);
      }

      const updated = await updateConstituent(orgId, id, body, userId);

      if (!updated) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Constituent not found"));
      }

      return { data: updated };
    },
  );

  /**
   * Soft-delete a constituent.
   *
   * Admin-only: deletion (even soft) is destructive enough that a non-admin
   * staff member shouldn't be able to scrub a record everyone else relies on
   * for fundraising history and GDPR audit. Operational write actions
   * (create / update) stay open to the `user` role.
   */
  app.delete(
    "/constituents/:id",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Constituents"],
        params: IdParams,
        response: { 200: DataResponse(ConstituentResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      const userId = request.auth?.userId;
      if (!orgId || !userId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const { id } = request.params as { id: string };
      const deleted = await deleteConstituent(orgId, id, userId);

      if (!deleted) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Constituent not found"));
      }

      return { data: deleted };
    },
  );

  /** Merge a duplicate constituent into a primary constituent */
  app.post(
    "/constituents/:id/merge",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Constituents"],
        params: IdParams,
        body: MergeBody,
        headers: MergeHeaders,
        response: {
          200: DataResponse(MergeResult),
          400: ProblemDetailSchema,
          409: ProblemDetailSchema,
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
      const { targetId } = request.body as { targetId: string };
      const ifMatch = (request.headers as Record<string, string | undefined>)["if-match"];

      if (id === targetId) {
        return reply
          .status(400)
          .send(problemDetail(400, "Bad Request", "Cannot merge a constituent into itself"));
      }

      try {
        const result = await mergeConstituents(
          orgId,
          id,
          targetId,
          // Pass both the effective subject and the impersonating actor so the
          // merge_history snapshot records double-attribution (ADR-016 / #24).
          { userId, actorId: request.auth?.act?.sub ?? null },
          { ifMatch },
        );

        if (!result) {
          return reply
            .status(404)
            .send(problemDetail(404, "Not Found", "One or both constituents not found"));
        }

        // RFC 7232: successful conditional mutation returns the new ETag.
        reply.header("ETag", result.etag);
        return { data: result };
      } catch (err) {
        if (err instanceof MergePreconditionError) {
          return reply
            .status(409)
            .send(
              problemDetail(
                409,
                "Conflict",
                "The survivor constituent has been modified since you last read it. Refetch and retry.",
              ),
            );
        }
        throw err;
      }
    },
  );

  /**
   * Bulk-send a transactional email to the supplied constituents (Epic #274;
   * partial-send tracking per issue #326).
   *
   * The HTTP path inserts a `bulk_email_jobs` tracking row + outbox event
   * and returns immediately — the actual delivery happens asynchronously
   * in the `emails` queue worker. Response carries `jobId` so the UI can
   * start polling `GET /constituents/bulk-email-jobs/:id` for live
   * delivered/total progress. Skipped recipients (no email on file) are
   * reported back so the UI can surface "12 queued, 3 skipped" without
   * re-querying.
   *
   * Rate-limited: a single org-admin spamming the bulk-email button is the
   * primary unintentional abuse path.
   */
  app.post(
    "/constituents/bulk-email",
    {
      // Flag-gate FIRST so a disabled feature looks identical to a
      // typo'd URL (404) — `requireFlag` returns before `requireOrgAdmin`
      // even runs so an unauthorised scanner can't enumerate which
      // gated routes need which roles.
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.COMMUNICATION_BULK_EMAIL), requireOrgAdmin],
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["Constituents"],
        body: Type.Object({
          constituentIds: Type.Array(UuidSchema, { minItems: 1, maxItems: 500 }),
          subject: Type.String({ minLength: 1, maxLength: 200 }),
          body: Type.String({ minLength: 1, maxLength: 50000 }),
        }),
        response: {
          202: DataResponse(
            Type.Object({
              jobId: UuidSchema,
              queued: Type.Integer(),
              skippedNoEmail: Type.Integer(),
            }),
          ),
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
      const body = request.body as {
        constituentIds: string[];
        subject: string;
        body: string;
      };
      try {
        const result = await dispatchBulkEmail(
          orgId,
          userId,
          {
            constituentIds: body.constituentIds,
            subject: body.subject,
            body: body.body,
          },
          request,
        );
        reply.header("Location", `/v1/constituents/bulk-email-jobs/${result.jobId}`);
        return reply.status(202).send({ data: result });
      } catch (err) {
        if (err instanceof BulkEmailValidationError) {
          return reply.status(400).send(problemDetail(400, "Bad Request", err.message));
        }
        throw err;
      }
    },
  );

  // ─── Bulk-email job tracking + resume (issue #326) ─────────────────────

  /**
   * List recent bulk-email jobs for the tenant (newest 20). Drives the
   * "Recent emails" panel in the constituents table.
   */
  app.get(
    "/constituents/bulk-email-jobs",
    {
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.COMMUNICATION_BULK_EMAIL), requireOrgAdmin],
      // PR #352 review M1: cap polling cadence even on the list path —
      // matches the per-id GET below so a buggy client (multiple tabs,
      // runaway useEffect) can't bypass the cadence limit by hitting
      // the list endpoint instead.
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["Constituents"],
        response: {
          200: DataArrayResponseNoPagination(BulkEmailJobRowSchema),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const rows = await listBulkEmailJobs(orgId);
      return { data: rows };
    },
  );

  /**
   * Get a single bulk-email job. Used for short-interval polling — the
   * frontend hits this every 2s while a job is in-flight. Rate-limited at
   * 60/min/admin so a buggy client (multiple tabs, runaway useEffect)
   * can't hammer the endpoint past the intended polling cadence — same
   * cadence as the postal-export poll route.
   */
  app.get(
    "/constituents/bulk-email-jobs/:id",
    {
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.COMMUNICATION_BULK_EMAIL), requireOrgAdmin],
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["Constituents"],
        params: IdParams,
        response: {
          200: DataResponse(BulkEmailJobRowSchema),
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
      const row = await getBulkEmailJob(orgId, id);
      if (!row) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Bulk email job not found"));
      }
      return { data: row };
    },
  );

  /**
   * Resume a bulk-email job — creates a fresh job targeting the recipients
   * the source never reached (`constituent_ids \ delivered_constituent_ids`).
   *
   * Accepts source jobs in:
   *   - `partial` / `failed` — natural terminal states.
   *   - `processing` if stalled (no `updated_at` movement for ≥ 10 min) —
   *     the Redis-wipe / OOM-kill / accessory-reboot case the issue calls
   *     out. The error code is the same as the running case so the UI
   *     surfaces a consistent "try again later" message; the API
   *     decides eligibility, the UI doesn't.
   */
  app.post(
    "/constituents/bulk-email-jobs/:id/resume",
    {
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.COMMUNICATION_BULK_EMAIL), requireOrgAdmin],
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["Constituents"],
        params: IdParams,
        response: {
          202: DataResponse(BulkEmailJobRowSchema),
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
      try {
        const result = await resumeBulkEmailJob(orgId, userId, id, request);
        reply.header("Location", `/v1/constituents/bulk-email-jobs/${result.id}`);
        return reply.status(202).send({ data: result });
      } catch (err) {
        if (err instanceof BulkEmailResumeError) {
          // PR #352 review — Log-3: emit a structured warn so the
          // rejection reason lands in Loki, not only the HTTP body.
          request.log.warn(
            { code: err.code, sourceJobId: id, orgId },
            "bulk email resume rejected",
          );
          if (err.code === "job_not_found") {
            return reply.status(404).send(problemDetail(404, err.code, err.message));
          }
          return reply.status(400).send(problemDetail(400, err.code, err.message));
        }
        throw err;
      }
    },
  );

  // ─── Bulk-import constituents (Epic #373) ──────────────────────────────
  // Mounted from the same `constituentRoutes` registrar so the `/v1`
  // prefix is shared. All endpoints + their per-route guards live in
  // `bulk-import/routes.ts`.
  await registerBulkImportRoutes(app);

  // ─── Advanced filters (Issue #422) ──────────────────────────────
  // Filter endpoints are feature-flagged and provide complex querying
  // capabilities for constituents with pattern detection
  await registerFilterEndpoints(app);
}
