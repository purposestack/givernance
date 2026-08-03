/** Constituent routes — full CRUD with search, filtering, and soft-delete */

import { createHash } from "node:crypto";
import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import { auditLogs } from "@givernance/shared/schema";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  CustomFieldValidationError,
  customFieldsDisabledProblem,
  customFieldsProblem,
} from "../../lib/custom-field-values.js";
import { withTenantContext } from "../../lib/db.js";
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
  buildCustomSerializer,
  getActiveDefinitions,
  getReadableDefinitions,
} from "../customization/lib/value-service.js";
import {
  BulkEmailResumeError,
  BulkEmailValidationError,
  dispatchBulkEmail,
  getBulkEmailJob,
  listBulkEmailJobs,
  resumeBulkEmailJob,
} from "./bulk-email-service.js";
import { registerBulkImportRoutes } from "./bulk-import/routes.js";
import { constituentsExportFilename, streamConstituentsCsv } from "./export.js";
import { type FieldRegistryBundle, getFieldRegistryBundle } from "./filters/field-registry.js";
import { registerFilterEndpoints } from "./filters/filter.routes.js";
import { FilterService } from "./filters/filter.service.js";
import type { FilterQuery } from "./filters/types.js";
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

/**
 * Custom-field merge-patch carrier (Epic #539). Values are validated at
 * runtime against the org's active definition catalog (types, options,
 * lengths) — the TypeBox layer only bounds the shape: an object keyed by
 * definition keys, `null` meaning "clear this key". Only forwarded to the
 * service when `constituents.custom_fields` is on (422 otherwise).
 */
const CustomPatchBody = Type.Record(Type.String({ maxLength: 63 }), Type.Unknown());

/**
 * Custom values in responses. The route serializes the stored blob
 * through `buildCustomSerializer(activeDefs)` before it reaches this
 * schema — the definition-driven firewall; this Record only types what
 * that serializer emits. `String` last: fast-json-stringify coerces to
 * the first compatible union member, and everything is string-coercible.
 */
const CustomValuesResponse = Type.Record(
  Type.String(),
  Type.Union([Type.Boolean(), Type.Number(), Type.Array(Type.String()), Type.String()]),
);

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
  custom: Type.Optional(CustomPatchBody),
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
    custom: Type.Optional(CustomPatchBody),
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
    /**
     * Advanced-filter DSL (Epic #418 / ADR-033): a JSON-serialised
     * `FilterQuery` — the same shape `POST /v1/constituents/filter` accepts
     * in its body. Lets the list page apply builder queries while keeping
     * the URL shareable (`?filters=<encoded JSON>`). Gated on the
     * `advanced_filters` flag (404 when off, mirroring `requireFlag`) and
     * validated through `FilterService.validateQuery` (400 with error list).
     * 8 KiB cap: the DSL is bounded at 10 conditions, so anything larger is
     * garbage or an attack, not a real filter.
     */
    filters: Type.Optional(Type.String({ maxLength: 8192 })),
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
  // as a deprecated back-compat mirror equal to `types[0]` — flagged
  // `deprecated` so OpenAPI consumers get the removal signal.
  types: Type.Array(Type.String()),
  type: Type.String({
    deprecated: true,
    description: "Back-compat mirror of types[0]; removed once readers migrate to `types`.",
  }),
  tags: Type.Union([Type.Null(), Type.Array(Type.String())]),
  // Epic #539 — present only when `constituents.custom_fields` is on;
  // always the serializer's key-picked output, never the raw blob.
  custom: Type.Optional(CustomValuesResponse),
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

/**
 * Custom-fields gate (Epic #539). Like multi-type above, the flag is NOT
 * a `requireFlag` preHandler on the CRUD routes — only the `custom`
 * affordance is gated, never the endpoint. With the flag off, a payload
 * carrying `custom` is a 422 and responses omit the key entirely.
 */
async function isCustomFieldsEnabled(request: FastifyRequest, orgId: string): Promise<boolean> {
  const flags = request.flagService ?? defaultFlagService;
  return flags.isEnabled(FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS, { orgId });
}

/**
 * Duplicate pre-check for the create handler — returns the matches to
 * put in the 409 body, or null when creation may proceed (`force=true`
 * or no candidates).
 */
async function findCreateDuplicates(
  orgId: string,
  body: { firstName: string; lastName: string; email?: string },
  force: boolean | undefined,
) {
  if (force) return null;
  const duplicates = await findDuplicates(orgId, {
    firstName: body.firstName,
    lastName: body.lastName,
    email: body.email,
  });
  return duplicates.length > 0 ? duplicates : null;
}

/**
 * One-shot gate for the create/update handlers: resolves the flag and,
 * when a `custom` payload arrives while it's off, the 422 to send.
 */
async function resolveCustomGate(
  request: FastifyRequest,
  orgId: string,
  custom: unknown,
): Promise<{ enabled: boolean; problem: ReturnType<typeof problemDetail> | null }> {
  const enabled = await isCustomFieldsEnabled(request, orgId);
  // Empty-object payloads pass with the flag off (same rule as the
  // donation/campaign gates) — only actual gated values are rejected.
  const carriesValues =
    custom !== undefined &&
    custom !== null &&
    typeof custom === "object" &&
    Object.keys(custom as Record<string, unknown>).length > 0;
  const problem =
    !enabled && carriesValues
      ? customFieldsDisabledProblem(FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS)
      : null;
  return { enabled, problem };
}

type FiltersParamResult =
  | { ok: true; filter: FilterQuery | undefined; registryBundle?: FieldRegistryBundle }
  | { ok: false; status: 400 | 404; problem: ReturnType<typeof problemDetail> };

/**
 * Shared `?filters=` DSL handling for the list + export routes (Epic
 * #418 / ADR-033). With `advanced_filters` off the param does not exist,
 * so a request carrying it 404s exactly like the gated routes do
 * (`requireFlag` posture — never silently return an UNFILTERED result an
 * operator believes is filtered, and never disclose the feature to a
 * scanner via a 400/403).
 */
async function parseFiltersParam(
  request: FastifyRequest,
  orgId: string,
  filters: string | undefined,
): Promise<FiltersParamResult> {
  if (filters === undefined) {
    return { ok: true, filter: undefined };
  }

  const flags = request.flagService ?? defaultFlagService;
  const enabled = await flags.isEnabled(FEATURE_FLAG_KEYS.ADVANCED_FILTERS, { orgId });
  if (!enabled) {
    request.log.info(
      {
        event: "flag.route_gated",
        flagKey: FEATURE_FLAG_KEYS.ADVANCED_FILTERS,
        path: request.routeOptions.url ?? request.url,
        method: request.method,
      },
      "List filters param gated off — feature flag disabled",
    );
    return { ok: false, status: 404, problem: problemDetail(404, "Not Found", "Route not found") };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(filters);
  } catch {
    return {
      ok: false,
      status: 400,
      problem: problemDetail(
        400,
        "Invalid filter query",
        "The filters parameter is not valid JSON",
      ),
    };
  }

  // `validateQuery` expects an object — reject scalars/null/arrays here
  // so a hand-edited URL can't crash it with a property access on null.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      status: 400,
      problem: problemDetail(
        400,
        "Invalid filter query",
        "The filters parameter must be a JSON object",
      ),
    };
  }

  // Per-org registry so `custom.<key>` conditions validate and compile;
  // returned to the caller so the downstream where-clause build reuses it.
  const registryBundle = await getFieldRegistryBundle(orgId);
  const filterService = new FilterService(orgId, request.log, registryBundle);
  const validation = filterService.validateQuery(parsed as FilterQuery);
  if (!validation.valid) {
    if (validation.archivedFields.length > 0) {
      return {
        ok: false,
        status: 400,
        problem: problemDetail(
          400,
          "custom_field_archived",
          "The filter references archived custom fields",
          { errors: validation.errors, archived_fields: validation.archivedFields },
        ),
      };
    }
    return {
      ok: false,
      status: 400,
      problem: problemDetail(400, "Invalid filter query", "The filter query contains errors", {
        errors: validation.errors,
      }),
    };
  }

  return { ok: true, filter: parsed as FilterQuery, registryBundle };
}

/**
 * Applies the strict-response firewall to rows about to be serialized:
 * flag off → the `custom` key is removed; flag on → the stored blob is
 * replaced by definition-driven serializer output, so stray keys never
 * leave the API. List/mutation responses serialize ACTIVE definitions
 * only; the detail read passes `includeArchived` so archived-definition
 * values stay readable there (docs/35: "values retained, read-only on
 * detail + exports") — never on forms, filters, or columns.
 */
async function projectCustomOnRows(
  orgId: string,
  enabled: boolean,
  rows: Array<Record<string, unknown>>,
  options?: { includeArchived?: boolean },
): Promise<void> {
  if (!enabled) {
    for (const row of rows) {
      delete row.custom;
    }
    return;
  }
  const defs = options?.includeArchived
    ? await getReadableDefinitions(orgId, "constituent")
    : await getActiveDefinitions(orgId, "constituent");
  const serialize = buildCustomSerializer(defs);
  for (const row of rows) {
    row.custom = serialize(row.custom);
  }
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
        filters?: string;
      };

      const filtersResult = await parseFiltersParam(request, orgId, query.filters);
      if (!filtersResult.ok) {
        return reply.status(filtersResult.status).send(filtersResult.problem);
      }
      const advancedFilter = filtersResult.filter;

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
        advancedFilter,
        registryBundle: filtersResult.registryBundle,
      });

      await projectCustomOnRows(
        orgId,
        await isCustomFieldsEnabled(request, orgId),
        result.data as unknown as Array<Record<string, unknown>>,
      );

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

      await projectCustomOnRows(
        orgId,
        await isCustomFieldsEnabled(request, orgId),
        [constituent as unknown as Record<string, unknown>],
        { includeArchived: true },
      );

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

  /**
   * Constituents CSV export (Epic #539 §5) — canonical columns + one
   * column per `exportable` non-archived custom-field definition
   * (admin sort order, option ids resolved to labels, multi joined
   * `'; '`). Streams keyset-paginated batches; honors the same
   * `?filters=` DSL as the list route. Never plan-gated — quotas gate
   * field creation, never data egress — and doubles as the DSAR /
   * Art. 15 vehicle (docs/35 §6). `requireFlag` FIRST: with
   * `constituents.custom_fields` off the route does not exist (404).
   * `requireWrite` (not bare auth): bulk egress of the full tenant PII
   * set has no viewer-role use case — same posture as duplicates/search.
   * "Never plan-gated" constrains plan gating, not role gating.
   */
  app.get(
    "/constituents/export.csv",
    {
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS), requireWrite],
      schema: {
        tags: ["Constituents"],
        querystring: Type.Object({
          /** Same 8 KiB-capped JSON `FilterQuery` as `GET /constituents`. */
          filters: Type.Optional(Type.String({ maxLength: 8192 })),
        }),
        // No 200 schema: the response is a streamed CSV body, not JSON.
        response: { 400: ProblemDetailSchema, ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const query = request.query as { filters?: string };
      const filtersResult = await parseFiltersParam(request, orgId, query.filters);
      if (!filtersResult.ok) {
        return reply.status(filtersResult.status).send(filtersResult.problem);
      }

      // Archived defs included (labels suffixed): the export doubles as the
      // DSAR / Art. 15 vehicle, so retained values must not silently vanish
      // from it when a definition is archived.
      const exportableDefs = (await getReadableDefinitions(orgId, "constituent")).filter(
        (def) => def.exportable,
      );

      // Bulk PII egress leaves a trail (GDPR Art. 5(2)): who exported,
      // under which filter (hashed — the DSL itself may embed PII terms).
      await withTenantContext(orgId, (tx) =>
        tx.insert(auditLogs).values({
          orgId,
          userId: request.auth?.userId ?? "",
          actorId: request.auth?.act?.sub ?? null,
          action: "constituents.exported",
          resourceType: "constituents",
          newValues: {
            filterHash: query.filters
              ? createHash("sha256").update(query.filters).digest("hex").slice(0, 16)
              : null,
            customColumns: exportableDefs.length,
          },
        }),
      );

      reply.header("content-type", "text/csv; charset=utf-8");
      reply.header("content-disposition", `attachment; filename="${constituentsExportFilename()}"`);
      return reply.send(
        streamConstituentsCsv(
          orgId,
          exportableDefs,
          filtersResult.filter,
          filtersResult.registryBundle,
        ),
      );
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
        custom?: Record<string, unknown>;
      };
      const query = request.query as { force?: boolean };

      const multiTypeError = await rejectMultiTypeWhenDisabled(request, orgId, body.types);
      if (multiTypeError) {
        return reply.status(422).send(multiTypeError);
      }

      const customGate = await resolveCustomGate(request, orgId, body.custom);
      if (customGate.problem) {
        return reply.status(422).send(customGate.problem);
      }

      const duplicates = await findCreateDuplicates(orgId, body, query.force);
      if (duplicates) {
        return reply.status(409).send({
          ...problemDetail(409, "Conflict", "Potential duplicate constituents found"),
          duplicates,
        });
      }

      try {
        // Flag on: always pass a patch (`{}` when the body has none) so
        // `required` definitions are enforced on the create path.
        const constituent = await createConstituent(orgId, {
          ...body,
          custom: customGate.enabled ? (body.custom ?? {}) : undefined,
        });
        if (constituent) {
          reply.header("Location", `/v1/constituents/${constituent.id}`);
          await projectCustomOnRows(orgId, customGate.enabled, [
            constituent as unknown as Record<string, unknown>,
          ]);
        }
        return reply.status(201).send({ data: constituent });
      } catch (err) {
        if (err instanceof CustomFieldValidationError) {
          return reply.status(422).send(customFieldsProblem(err.errors));
        }
        throw err;
      }
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
        custom?: Record<string, unknown>;
      };

      const multiTypeError = await rejectMultiTypeWhenDisabled(request, orgId, body.types);
      if (multiTypeError) {
        return reply.status(422).send(multiTypeError);
      }

      // Same gate as the create route (and the donation/campaign writes):
      // an empty `custom: {}` passes with the flag off — only actual gated
      // values are rejected. Uniform contract across all custom-carrying
      // write routes.
      const customGate = await resolveCustomGate(request, orgId, body.custom);
      if (customGate.problem) {
        return reply.status(422).send(customGate.problem);
      }

      try {
        const updated = await updateConstituent(
          orgId,
          id,
          // Flag off → strip the (necessarily empty) patch so the service
          // never touches the column.
          customGate.enabled ? body : { ...body, custom: undefined },
          userId,
          request,
        );

        if (!updated) {
          return reply.status(404).send(problemDetail(404, "Not Found", "Constituent not found"));
        }

        await projectCustomOnRows(orgId, customGate.enabled, [
          updated as unknown as Record<string, unknown>,
        ]);

        return { data: updated };
      } catch (err) {
        if (err instanceof CustomFieldValidationError) {
          return reply.status(422).send(customFieldsProblem(err.errors));
        }
        throw err;
      }
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
      const deleted = await deleteConstituent(orgId, id, userId, request);

      if (!deleted) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Constituent not found"));
      }

      await projectCustomOnRows(orgId, await isCustomFieldsEnabled(request, orgId), [
        deleted as unknown as Record<string, unknown>,
      ]);

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
          request,
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
