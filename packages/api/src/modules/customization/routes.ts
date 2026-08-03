/**
 * Customization routes — the custom-field registry API (Epic #539,
 * docs/35 §permissions matrix).
 *
 * Guard chain on every route: the flag guard FIRST (404 when every
 * domain kill-switch is off — the routes must look like typo'd URLs to
 * scanners), then auth. The catalog + usage reads are operator surface;
 * catalog GET needs only `requireAuth` (any tenant member renders forms
 * from it), usage and every mutation are `requireOrgAdmin`. Domain
 * precision on top of the any-flag gate: a request that targets a
 * specific domain (create body, or the domain of the addressed row)
 * 404s when THAT domain's flag is off.
 */

import {
  CUSTOM_FIELD_DESCRIPTION_MAX_LENGTH,
  CUSTOM_FIELD_DOMAIN_VALUES,
  CUSTOM_FIELD_LABEL_MAX_LENGTH,
  CUSTOM_FIELD_OPTION_ID_PATTERN,
  CUSTOM_FIELD_OPTION_LABEL_MAX_LENGTH,
  CUSTOM_FIELD_PURPOSE_MAX_LENGTH,
  CUSTOM_FIELD_QUOTA_CEILINGS,
  CUSTOM_FIELD_TYPE_VALUES,
  type CustomFieldDomain,
  type CustomFieldType,
} from "@givernance/shared/custom-fields";
import type { CustomFieldDefinitionRow } from "@givernance/shared/schema";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireAuth, requireOrgAdmin } from "../../lib/guards.js";
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
  getEnabledCustomFieldDomains,
  isCustomFieldDomainEnabled,
  requireAnyCustomFieldsFlag,
} from "./lib/domain-flags.js";
import {
  type AuditActor,
  addOption,
  archiveDefinition,
  CustomFieldRequestError,
  createDefinition,
  getDefinition,
  getUsage,
  listDefinitions,
  mergeOption,
  reorderDefinitions,
  restoreDefinition,
  undoOptionMerge,
  updateDefinition,
  updateOption,
} from "./service.js";

const DomainSchema = Type.Union(CUSTOM_FIELD_DOMAIN_VALUES.map((value) => Type.Literal(value)));
const FieldTypeSchema = Type.Union(CUSTOM_FIELD_TYPE_VALUES.map((value) => Type.Literal(value)));

const OptionSchema = Type.Object(
  {
    id: Type.String(),
    label: Type.String(),
    active: Type.Boolean(),
    sortOrder: Type.Integer(),
    mergedInto: Type.Optional(Type.String()),
    /** Undo handle + window anchor for merged options (settings surface). */
    mergeId: Type.Optional(UuidSchema),
    mergedAt: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const DefinitionResponse = Type.Object(
  {
    id: UuidSchema,
    domain: DomainSchema,
    key: Type.String(),
    label: Type.String(),
    description: Type.Union([Type.String(), Type.Null()]),
    type: FieldTypeSchema,
    options: Type.Array(OptionSchema),
    sortOrder: Type.Integer(),
    required: Type.Boolean(),
    filterable: Type.Boolean(),
    exportable: Type.Boolean(),
    showOnRelated: Type.Boolean(),
    sensitive: Type.Boolean(),
    purposeText: Type.Union([Type.String(), Type.Null()]),
    archivedAt: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  { additionalProperties: false },
);

const ListQuery = Type.Object(
  {
    domain: Type.Optional(DomainSchema),
    includeArchived: Type.Optional(Type.Boolean({ default: false })),
  },
  { additionalProperties: false },
);

const CreateBody = Type.Object(
  {
    domain: DomainSchema,
    // Full key validation (regex + RESERVED_KEYS) is service-side → 422
    // with a named code; the schema only bounds the length.
    key: Type.String({ minLength: 2, maxLength: 63 }),
    label: Type.String({ minLength: 1, maxLength: CUSTOM_FIELD_LABEL_MAX_LENGTH }),
    description: Type.Optional(
      Type.Union([Type.String({ maxLength: CUSTOM_FIELD_DESCRIPTION_MAX_LENGTH }), Type.Null()]),
    ),
    type: FieldTypeSchema,
    options: Type.Optional(
      Type.Array(
        Type.Object(
          { label: Type.String({ minLength: 1, maxLength: CUSTOM_FIELD_OPTION_LABEL_MAX_LENGTH }) },
          { additionalProperties: false },
        ),
        { maxItems: CUSTOM_FIELD_QUOTA_CEILINGS.optionsPerPicklist },
      ),
    ),
    sortOrder: Type.Optional(Type.Integer({ minimum: 0 })),
    required: Type.Optional(Type.Boolean()),
    filterable: Type.Optional(Type.Boolean()),
    exportable: Type.Optional(Type.Boolean()),
    showOnRelated: Type.Optional(Type.Boolean()),
    sensitive: Type.Optional(Type.Boolean()),
    purposeText: Type.Optional(
      Type.Union([Type.String({ maxLength: CUSTOM_FIELD_PURPOSE_MAX_LENGTH }), Type.Null()]),
    ),
  },
  { additionalProperties: false },
);

/** `key` and `type` are immutable by omission — never PATCHable. */
const UpdateBody = Type.Object(
  {
    label: Type.Optional(Type.String({ minLength: 1, maxLength: CUSTOM_FIELD_LABEL_MAX_LENGTH })),
    description: Type.Optional(
      Type.Union([Type.String({ maxLength: CUSTOM_FIELD_DESCRIPTION_MAX_LENGTH }), Type.Null()]),
    ),
    sortOrder: Type.Optional(Type.Integer({ minimum: 0 })),
    required: Type.Optional(Type.Boolean()),
    filterable: Type.Optional(Type.Boolean()),
    exportable: Type.Optional(Type.Boolean()),
    showOnRelated: Type.Optional(Type.Boolean()),
    sensitive: Type.Optional(Type.Boolean()),
    purposeText: Type.Optional(
      Type.Union([Type.String({ maxLength: CUSTOM_FIELD_PURPOSE_MAX_LENGTH }), Type.Null()]),
    ),
  },
  { additionalProperties: false, minProperties: 1 },
);

const ReorderBody = Type.Object(
  {
    domain: DomainSchema,
    ids: Type.Array(UuidSchema, { minItems: 1, maxItems: 100 }),
  },
  { additionalProperties: false },
);

const OptionCreateBody = Type.Object(
  { label: Type.String({ minLength: 1, maxLength: CUSTOM_FIELD_OPTION_LABEL_MAX_LENGTH }) },
  { additionalProperties: false },
);

const OptionUpdateBody = Type.Object(
  {
    label: Type.Optional(
      Type.String({ minLength: 1, maxLength: CUSTOM_FIELD_OPTION_LABEL_MAX_LENGTH }),
    ),
    active: Type.Optional(Type.Boolean()),
    sortOrder: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false, minProperties: 1 },
);

const OptionParams = Type.Object(
  { id: UuidSchema, optId: Type.String({ pattern: CUSTOM_FIELD_OPTION_ID_PATTERN.source }) },
  { additionalProperties: false },
);

const MergeBody = Type.Object(
  { targetOptionId: Type.String({ pattern: CUSTOM_FIELD_OPTION_ID_PATTERN.source }) },
  { additionalProperties: false },
);

const MergeQuery = Type.Object(
  { dryRun: Type.Optional(Type.Boolean({ default: false })) },
  { additionalProperties: false },
);

const MergeResponse = Type.Object(
  {
    dryRun: Type.Boolean(),
    affectedCount: Type.Integer(),
    mergeId: Type.Union([UuidSchema, Type.Null()]),
    /** End of the 30-day undo window (ISO); null on dry-run. */
    undoExpiresAt: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

const UndoParams = Type.Object(
  {
    id: UuidSchema,
    optId: Type.String({ pattern: CUSTOM_FIELD_OPTION_ID_PATTERN.source }),
    mergeId: UuidSchema,
  },
  { additionalProperties: false },
);

const UndoResponse = Type.Object({ mergeId: UuidSchema }, { additionalProperties: false });

const UsageQuery = Type.Object(
  { domain: Type.Optional(DomainSchema) },
  { additionalProperties: false },
);

const UsageOptionSchema = Type.Object(
  {
    id: Type.String(),
    label: Type.String(),
    active: Type.Boolean(),
    /** Exact count as a string, or `'< 5'` (k-anonymity floor). */
    count: Type.String(),
  },
  { additionalProperties: false },
);

const UsageFieldSchema = Type.Object(
  {
    id: UuidSchema,
    key: Type.String(),
    label: Type.String(),
    type: FieldTypeSchema,
    sortOrder: Type.Integer(),
    filled: Type.String(),
    fillRatePercent: Type.Union([Type.Number(), Type.Null()]),
    options: Type.Array(UsageOptionSchema),
  },
  { additionalProperties: false },
);

const UsageDomainSchema = Type.Object(
  {
    domain: DomainSchema,
    totalRows: Type.Integer(),
    quotas: Type.Object(
      {
        fieldsPerDomain: Type.Object(
          { limit: Type.Integer(), used: Type.Integer() },
          { additionalProperties: false },
        ),
        optionsPerPicklist: Type.Object({ limit: Type.Integer() }, { additionalProperties: false }),
        showOnRelatedFields: Type.Object(
          { limit: Type.Integer(), used: Type.Integer() },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    fields: Type.Array(UsageFieldSchema),
  },
  { additionalProperties: false },
);

const NOT_FOUND = problemDetail(404, "Not Found", "Custom field not found");

/**
 * Explicit row → wire mapping (dates to ISO strings; `orgId`/`createdBy`
 * never leave the service layer). The nullable `archivedAt` union makes
 * fast-json-stringify's anyOf pick by validation, so Date instances must
 * be stringified before serialization.
 */
function serializeDefinition(row: CustomFieldDefinitionRow) {
  return {
    id: row.id,
    domain: row.domain,
    key: row.key,
    label: row.label,
    description: row.description,
    type: row.type,
    options: row.options,
    sortOrder: row.sortOrder,
    required: row.required,
    filterable: row.filterable,
    exportable: row.exportable,
    showOnRelated: row.showOnRelated,
    sensitive: row.sensitive,
    purposeText: row.purposeText,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function auditActor(request: FastifyRequest): AuditActor {
  return {
    userId: request.auth?.userId ?? "",
    actorId: request.auth?.act?.sub ?? null,
    userRowId: request.auth?.userRowId ?? null,
  };
}

function sendRequestError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof CustomFieldRequestError) {
    return reply
      .status(error.status)
      .send(problemDetail(error.status, error.title, error.message, error.extensions));
  }
  throw error;
}

export async function customizationRoutes(app: FastifyInstance) {
  app.get(
    "/custom-fields",
    {
      preHandler: [requireAnyCustomFieldsFlag, requireAuth],
      schema: {
        tags: ["Custom Fields"],
        querystring: ListQuery,
        response: { 200: DataArrayResponseNoPagination(DefinitionResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const query = request.query as { domain?: CustomFieldDomain; includeArchived?: boolean };
      const enabled = await getEnabledCustomFieldDomains(request);
      const domains = (query.domain ? [query.domain] : [...CUSTOM_FIELD_DOMAIN_VALUES]).filter(
        (domain) => enabled.has(domain),
      );
      const rows = await listDefinitions(orgId, {
        domains,
        includeArchived: query.includeArchived ?? false,
      });
      return { data: rows.map(serializeDefinition) };
    },
  );

  app.post(
    "/custom-fields",
    {
      preHandler: [requireAnyCustomFieldsFlag, requireAuth, requireOrgAdmin],
      schema: {
        tags: ["Custom Fields"],
        body: CreateBody,
        response: {
          201: DataResponse(DefinitionResponse),
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
      const body = request.body as {
        domain: CustomFieldDomain;
        key: string;
        label: string;
        description?: string | null;
        type: CustomFieldType;
        options?: { label: string }[];
        sortOrder?: number;
        required?: boolean;
        filterable?: boolean;
        exportable?: boolean;
        showOnRelated?: boolean;
        sensitive?: boolean;
        purposeText?: string | null;
      };
      if (!(await isCustomFieldDomainEnabled(request, body.domain))) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Route not found"));
      }
      try {
        const row = await createDefinition(orgId, auditActor(request), body);
        return reply.status(201).send({ data: serializeDefinition(row) });
      } catch (error) {
        return sendRequestError(reply, error);
      }
    },
  );

  /**
   * Resolves the addressed row and enforces its domain flag BEFORE the
   * handler mutates anything: a cross-tenant or unknown id misses the
   * `eq(orgId)` predicate (ADR-019) and a definition of a switched-off
   * domain is as absent as its surfaces are — both 404, no side effects.
   */
  async function resolveGatedDefinition(
    request: FastifyRequest,
    reply: FastifyReply,
    orgId: string,
    id: string,
  ): Promise<CustomFieldDefinitionRow | null> {
    const row = await getDefinition(orgId, id);
    if (!row) {
      reply.status(404).send(NOT_FOUND);
      return null;
    }
    if (!(await isCustomFieldDomainEnabled(request, row.domain))) {
      reply.status(404).send(NOT_FOUND);
      return null;
    }
    return row;
  }

  app.patch(
    "/custom-fields/:id",
    {
      preHandler: [requireAnyCustomFieldsFlag, requireAuth, requireOrgAdmin],
      schema: {
        tags: ["Custom Fields"],
        params: IdParams,
        body: UpdateBody,
        response: {
          200: DataResponse(DefinitionResponse),
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
      const { id } = request.params as { id: string };
      if (!(await resolveGatedDefinition(request, reply, orgId, id))) return reply;
      try {
        const row = await updateDefinition(orgId, auditActor(request), id, request.body ?? {});
        if (!row) {
          return reply.status(404).send(NOT_FOUND);
        }
        return { data: serializeDefinition(row) };
      } catch (error) {
        return sendRequestError(reply, error);
      }
    },
  );

  app.delete(
    "/custom-fields/:id",
    {
      preHandler: [requireAnyCustomFieldsFlag, requireAuth, requireOrgAdmin],
      schema: {
        tags: ["Custom Fields"],
        params: IdParams,
        response: { 200: DataResponse(DefinitionResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const { id } = request.params as { id: string };
      if (!(await resolveGatedDefinition(request, reply, orgId, id))) return reply;
      const row = await archiveDefinition(orgId, auditActor(request), id);
      if (!row) {
        return reply.status(404).send(NOT_FOUND);
      }
      return { data: serializeDefinition(row) };
    },
  );

  app.post(
    "/custom-fields/:id/restore",
    {
      preHandler: [requireAnyCustomFieldsFlag, requireAuth, requireOrgAdmin],
      schema: {
        tags: ["Custom Fields"],
        params: IdParams,
        response: {
          200: DataResponse(DefinitionResponse),
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
      const { id } = request.params as { id: string };
      if (!(await resolveGatedDefinition(request, reply, orgId, id))) return reply;
      try {
        const row = await restoreDefinition(orgId, auditActor(request), id);
        if (!row) {
          return reply.status(404).send(NOT_FOUND);
        }
        return { data: serializeDefinition(row) };
      } catch (error) {
        return sendRequestError(reply, error);
      }
    },
  );

  app.post(
    "/custom-fields/reorder",
    {
      preHandler: [requireAnyCustomFieldsFlag, requireAuth, requireOrgAdmin],
      schema: {
        tags: ["Custom Fields"],
        body: ReorderBody,
        response: {
          200: DataArrayResponseNoPagination(DefinitionResponse),
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
      const body = request.body as { domain: CustomFieldDomain; ids: string[] };
      if (!(await isCustomFieldDomainEnabled(request, body.domain))) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Route not found"));
      }
      try {
        const rows = await reorderDefinitions(orgId, auditActor(request), body.domain, body.ids);
        return { data: rows.map(serializeDefinition) };
      } catch (error) {
        return sendRequestError(reply, error);
      }
    },
  );

  app.post(
    "/custom-fields/:id/options",
    {
      preHandler: [requireAnyCustomFieldsFlag, requireAuth, requireOrgAdmin],
      schema: {
        tags: ["Custom Fields"],
        params: IdParams,
        body: OptionCreateBody,
        response: {
          201: DataResponse(DefinitionResponse),
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
      const { id } = request.params as { id: string };
      const body = request.body as { label: string };
      if (!(await resolveGatedDefinition(request, reply, orgId, id))) return reply;
      try {
        const row = await addOption(orgId, auditActor(request), id, body.label);
        if (!row) {
          return reply.status(404).send(NOT_FOUND);
        }
        return reply.status(201).send({ data: serializeDefinition(row) });
      } catch (error) {
        return sendRequestError(reply, error);
      }
    },
  );

  app.patch(
    "/custom-fields/:id/options/:optId",
    {
      preHandler: [requireAnyCustomFieldsFlag, requireAuth, requireOrgAdmin],
      schema: {
        tags: ["Custom Fields"],
        params: OptionParams,
        body: OptionUpdateBody,
        response: {
          200: DataResponse(DefinitionResponse),
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
      const { id, optId } = request.params as { id: string; optId: string };
      if (!(await resolveGatedDefinition(request, reply, orgId, id))) return reply;
      try {
        const row = await updateOption(orgId, auditActor(request), id, optId, request.body ?? {});
        if (!row) {
          return reply.status(404).send(NOT_FOUND);
        }
        return { data: serializeDefinition(row) };
      } catch (error) {
        return sendRequestError(reply, error);
      }
    },
  );

  app.post(
    "/custom-fields/:id/options/:optId/merge",
    {
      preHandler: [requireAnyCustomFieldsFlag, requireAuth, requireOrgAdmin],
      schema: {
        tags: ["Custom Fields"],
        params: OptionParams,
        querystring: MergeQuery,
        body: MergeBody,
        response: {
          200: DataResponse(MergeResponse),
          202: DataResponse(MergeResponse),
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
      const { id, optId } = request.params as { id: string; optId: string };
      const { dryRun } = request.query as { dryRun?: boolean };
      const body = request.body as { targetOptionId: string };
      if (!(await resolveGatedDefinition(request, reply, orgId, id))) return reply;
      try {
        const result = await mergeOption(
          orgId,
          auditActor(request),
          id,
          optId,
          body.targetOptionId,
          {
            dryRun: dryRun ?? false,
          },
          request,
        );
        if (!result) {
          return reply.status(404).send(NOT_FOUND);
        }
        if (result.mergeId === null) {
          return {
            data: {
              dryRun: true,
              affectedCount: result.affectedCount,
              mergeId: null,
              undoExpiresAt: null,
            },
          };
        }
        // The backfill job is NOT enqueued here: the service emitted the
        // `option_merge_requested` outbox row inside the merge transaction,
        // so the relay owns delivery (crash/Redis-safe, idempotent jobId).
        return reply.status(202).send({
          data: {
            dryRun: false,
            affectedCount: result.affectedCount,
            mergeId: result.mergeId,
            undoExpiresAt: result.undoExpiresAt,
          },
        });
      } catch (error) {
        return sendRequestError(reply, error);
      }
    },
  );

  app.post(
    "/custom-fields/:id/options/:optId/merge/:mergeId/undo",
    {
      preHandler: [requireAnyCustomFieldsFlag, requireAuth, requireOrgAdmin],
      schema: {
        tags: ["Custom Fields"],
        params: UndoParams,
        response: {
          202: DataResponse(UndoResponse),
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
      const { id, optId, mergeId } = request.params as {
        id: string;
        optId: string;
        mergeId: string;
      };
      if (!(await resolveGatedDefinition(request, reply, orgId, id))) return reply;
      try {
        const result = await undoOptionMerge(
          orgId,
          auditActor(request),
          id,
          optId,
          mergeId,
          request,
        );
        if (!result) {
          return reply.status(404).send(NOT_FOUND);
        }
        return reply.status(202).send({ data: { mergeId: result.mergeId } });
      } catch (error) {
        return sendRequestError(reply, error);
      }
    },
  );

  app.get(
    "/custom-fields/usage",
    {
      preHandler: [requireAnyCustomFieldsFlag, requireAuth, requireOrgAdmin],
      schema: {
        tags: ["Custom Fields"],
        querystring: UsageQuery,
        response: {
          200: Type.Object(
            { data: Type.Array(UsageDomainSchema) },
            { additionalProperties: false },
          ),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const query = request.query as { domain?: CustomFieldDomain };
      const enabled = await getEnabledCustomFieldDomains(request);
      const domains = (query.domain ? [query.domain] : [...CUSTOM_FIELD_DOMAIN_VALUES]).filter(
        (domain) => enabled.has(domain),
      );
      const data = await getUsage(orgId, domains);
      return { data };
    },
  );
}
