/**
 * API routes for donation advanced filtering (flag
 * `donations.advanced_filters`).
 *
 * Mirrors the constituents filter routes (Epic #418 / ADR-033) with the
 * donation-domain catalog and WITHOUT the constituent-only surfaces
 * (patterns, campaign-add, execute route — list execution happens through
 * `GET /v1/donations?filters=`, see `../routes.ts`).
 *
 * `requireFlag` is the FIRST hook (before any role guard) so a scanner
 * hits 404 without enumerating role requirements.
 */

import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireFlag } from "../../../lib/flags/flag-guard.js";
import { requireAuth } from "../../../lib/guards.js";
import { DataResponse, ErrorResponses, problemDetail } from "../../../lib/schemas.js";
import type { DonationFieldMetadata } from "./field-registry.js";
import { getDonationFieldRegistryBundle } from "./field-registry.js";
import { DonationFilterService } from "./filter.service.js";

// ── DSL schemas ────────────────────────────────────────────────────────────
// Donation-local (NOT imported from the constituents module): the donation
// DSL has no `patterns` key at all, and every object is
// `additionalProperties: false`. A distinct recursive `$id` avoids any
// clash with the constituents `FilterCondition` schema on the same app.

const DonationFilterOperatorSchema = Type.Union([
  Type.Literal("eq"),
  Type.Literal("neq"),
  Type.Literal("gt"),
  Type.Literal("gte"),
  Type.Literal("lt"),
  Type.Literal("lte"),
  Type.Literal("between"),
  Type.Literal("in"),
  Type.Literal("contains"),
  Type.Literal("startsWith"),
  Type.Literal("endsWith"),
  // multi_picklist custom fields (Epic #539): contains-ALL / contains-ANY
  // over the `donations.custom` JSONB array lanes.
  Type.Literal("arrayContains"),
  Type.Literal("arrayOverlaps"),
  Type.Literal("isNull"),
  Type.Literal("isNotNull"),
]);

const LogicalOperatorSchema = Type.Union([Type.Literal("AND"), Type.Literal("OR")]);

const DonationFilterConditionSchema = Type.Recursive(
  (This) =>
    Type.Object(
      {
        field: Type.String({ maxLength: 200 }),
        operator: DonationFilterOperatorSchema,
        value: Type.Optional(Type.Any()),
        subConditions: Type.Optional(
          Type.Object(
            {
              operator: LogicalOperatorSchema,
              conditions: Type.Array(This),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  { $id: "DonationFilterCondition" },
);

export const DonationFilterQuerySchema = Type.Object(
  {
    operator: LogicalOperatorSchema,
    conditions: Type.Array(DonationFilterConditionSchema),
  },
  { additionalProperties: false },
);

const DonationFilterPreviewRequestSchema = Type.Object(
  { query: DonationFilterQuerySchema },
  { additionalProperties: false },
);

const DonationFilterSuggestionsQuerySchema = Type.Object(
  {
    field: Type.String({ maxLength: 200 }),
    search: Type.Optional(Type.String({ maxLength: 200 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 10 })),
  },
  { additionalProperties: false },
);

const DonationFilterPreviewResultSchema = Type.Object(
  {
    count: Type.Integer(),
    estimatedTime: Type.Optional(Type.Integer()),
  },
  { additionalProperties: false },
);

const CatalogOptionSchema = Type.Object(
  {
    id: Type.String(),
    label: Type.String(),
    active: Type.Boolean(),
  },
  { additionalProperties: false },
);

const DonationCatalogFieldSchema = Type.Object(
  {
    name: Type.String(),
    type: Type.Union([
      Type.Literal("string"),
      Type.Literal("number"),
      Type.Literal("date"),
      Type.Literal("boolean"),
      Type.Literal("array"),
    ]),
    operators: Type.Array(DonationFilterOperatorSchema),
    /**
     * Core donation fields are all i18n: the FE resolves
     * `donations.filters.<label>` (relative `fields.<dotted-name>` form,
     * same contract as the constituents catalog). Custom fields (Epic
     * #539) carry the operator-authored label, rendered literally.
     */
    label: Type.String(),
    labelKind: Type.Union([Type.Literal("literal"), Type.Literal("i18n")]),
    category: Type.Union([
      Type.Literal("donation"),
      Type.Literal("payment"),
      Type.Literal("attribution"),
      Type.Literal("receipt"),
      Type.Literal("custom"),
    ]),
    nullable: Type.Boolean(),
    /**
     * Raw DEFINITION type of a custom field ('picklist', 'currency', …) —
     * same contract as the constituents catalog: the FE translates it to
     * its input widget through the shared custom-type map. Absent on core
     * fields.
     */
    uiType: Type.Optional(
      Type.Union([
        Type.Literal("text"),
        Type.Literal("long_text"),
        Type.Literal("number"),
        Type.Literal("date"),
        Type.Literal("boolean"),
        Type.Literal("picklist"),
        Type.Literal("multi_picklist"),
        Type.Literal("currency"),
      ]),
    ),
    options: Type.Optional(Type.Array(CatalogOptionSchema)),
    /**
     * Disambiguates the `options[].label` contract:
     *   - "enum": ids of a closed platform enum — the FE localizes them
     *     (`donations.filters.options.<field>.<id>`), the label field
     *     merely repeats the id as a fallback.
     *   - "entity": per-org campaign/fund names — tenant data, rendered
     *     literally (never through i18n).
     * ABSENT on custom-field options (constituents-catalog contract): the
     * `labelKind: "literal"` of the field itself already carries the
     * render-verbatim contract for its operator-authored option labels.
     */
    optionsKind: Type.Optional(Type.Union([Type.Literal("enum"), Type.Literal("entity")])),
    valueUnit: Type.Optional(Type.Literal("cents")),
  },
  { additionalProperties: false },
);

/** Serialize one registry entry into its catalog payload. */
function serializeDonationCatalogField(
  field: DonationFieldMetadata,
  entityOptions: {
    campaigns: Array<{ id: string; label: string; active: boolean }>;
    funds: Array<{ id: string; label: string; active: boolean }>;
  },
) {
  // Custom fields (Epic #539): literal operator-authored label, raw
  // definition type as `uiType`, sortOrder-ordered options with the active
  // bit, nullable always true — the exact serialization contract of the
  // constituents catalog so the FE translation layer applies uniformly.
  if (field.source === "custom") {
    return {
      name: field.name,
      type: field.type,
      operators: field.operators,
      label: field.label ?? field.name,
      labelKind: "literal" as const,
      category: "custom" as const,
      nullable: field.nullable ?? true,
      ...(field.customType ? { uiType: field.customType } : {}),
      ...(field.options ? { options: field.options } : {}),
      ...(field.valueUnit ? { valueUnit: field.valueUnit } : {}),
    };
  }

  const options = field.dynamicOptions
    ? entityOptions[field.dynamicOptions]
    : field.enumOptions
      ? field.enumOptions.map((id) => ({ id, label: id, active: true }))
      : undefined;
  return {
    name: field.name,
    type: field.type,
    operators: field.operators,
    label: `fields.${field.name}`,
    labelKind: "i18n" as const,
    category: field.donationCategory,
    nullable: field.operators.includes("isNull"),
    ...(options ? { options } : {}),
    ...(options
      ? { optionsKind: field.dynamicOptions ? ("entity" as const) : ("enum" as const) }
      : {}),
    ...(field.valueUnit ? { valueUnit: field.valueUnit } : {}),
  };
}

/**
 * Map a failed `validateQuery` onto its 400 problem. A query referencing an
 * ARCHIVED donation-domain custom field gets the named
 * `custom_field_archived` problem (Epic #539) — persisted `?filters=` links
 * surface it explicitly instead of a generic invalid-query error.
 */
export function sendInvalidDonationQuery(
  reply: FastifyReply,
  validation: { errors: string[]; archivedFields?: string[] },
) {
  if (validation.archivedFields && validation.archivedFields.length > 0) {
    return reply.status(400).send(
      problemDetail(400, "custom_field_archived", "The filter references archived custom fields", {
        errors: validation.errors,
        archived_fields: validation.archivedFields,
      }),
    );
  }
  return reply.status(400).send(
    problemDetail(400, "Invalid filter query", "The filter query contains errors", {
      errors: validation.errors,
    }),
  );
}

export async function registerDonationFilterRoutes(app: FastifyInstance) {
  // The parent `donationRoutes` registrar is mounted at `/v1`, so the
  // paths below resolve to e.g. `GET /v1/donations/filter/fields`.
  app.register(async (app) => {
    // Flag gate FIRST (404 when off — anti-disclosure), auth second.
    app.addHook("onRequest", requireFlag(FEATURE_FLAG_KEYS.DONATIONS_ADVANCED_FILTERS));
    app.addHook("onRequest", requireAuth);

    /** Field catalog — enriched with per-org campaign / fund options. */
    app.get(
      "/donations/filter/fields",
      {
        schema: {
          tags: ["Donations"],
          summary: "Get available donation filter fields",
          description:
            "Metadata for every filterable donation field, including enum options and per-organisation campaign / fund pickers",
          response: {
            200: DataResponse(
              Type.Object(
                { fields: Type.Array(DonationCatalogFieldSchema) },
                { additionalProperties: false },
              ),
            ),
            ...ErrorResponses,
          },
        },
      },
      async (request, reply) => {
        if (!request.auth) {
          return reply
            .status(401)
            .send(problemDetail(401, "Authentication Required", "Request requires authentication"));
        }
        const { orgId } = request.auth;
        const bundle = await getDonationFieldRegistryBundle(orgId);
        const service = new DonationFilterService(orgId, request.log, bundle);
        const entityOptions = await service.getEntityOptions();
        const fields = Object.values(bundle.registry).map((field) =>
          serializeDonationCatalogField(field, entityOptions),
        );
        return reply.send({ data: { fields } });
      },
    );

    /** Count-only preview for the filter builder. */
    app.post<{ Body: typeof DonationFilterPreviewRequestSchema.static }>(
      "/donations/filter/preview",
      {
        config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
        schema: {
          tags: ["Donations"],
          summary: "Preview donation filter results",
          description: "Count of donations matching the filter without returning rows",
          body: DonationFilterPreviewRequestSchema,
          response: {
            200: DataResponse(DonationFilterPreviewResultSchema),
            ...ErrorResponses,
          },
        },
      },
      async (request, reply) => {
        if (!request.auth) {
          return reply
            .status(401)
            .send(problemDetail(401, "Authentication Required", "Request requires authentication"));
        }
        const { orgId } = request.auth;
        const bundle = await getDonationFieldRegistryBundle(orgId);
        const service = new DonationFilterService(orgId, request.log, bundle);

        const validation = service.validateQuery(request.body.query);
        if (!validation.valid) {
          return sendInvalidDonationQuery(reply, validation);
        }

        try {
          const result = await service.previewFilter(request.body.query);
          return reply.send({ data: result });
        } catch (error) {
          request.log.error({ error }, "Donation filter preview failed");
          return reply
            .status(500)
            .send(problemDetail(500, "Filter preview failed", "The filter could not be executed"));
        }
      },
    );

    /** Autocomplete suggestions (free-text payment methods, currencies). */
    app.get<{ Querystring: typeof DonationFilterSuggestionsQuerySchema.static }>(
      "/donations/filter/suggestions",
      {
        schema: {
          tags: ["Donations"],
          summary: "Get donation filter value suggestions",
          description: "Autocomplete suggestions for free-text donation filter fields",
          querystring: DonationFilterSuggestionsQuerySchema,
          response: {
            200: Type.Object({ data: Type.Array(Type.String()) }),
            ...ErrorResponses,
          },
        },
      },
      async (request, reply) => {
        if (!request.auth) {
          return reply
            .status(401)
            .send(problemDetail(401, "Authentication Required", "Request requires authentication"));
        }
        const { orgId } = request.auth;
        const bundle = await getDonationFieldRegistryBundle(orgId);
        const service = new DonationFilterService(orgId, request.log, bundle);
        const { field, search, limit } = request.query;
        const suggestions = await service.getFieldSuggestions(field, search, limit);
        return reply.send({ data: suggestions });
      },
    );
  });
}
