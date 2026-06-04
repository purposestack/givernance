/**
 * camt-statements + camt-unreconciled HTTP routes (Epic #318 PR #5).
 *
 * Endpoints (per docs/25 §6 permissions matrix):
 *
 *   POST   /v1/bank-accounts/:id/statements        — requireOrgAdmin (multipart .xml upload)
 *   GET    /v1/camt-statements                     — requireOrgAdmin (list, paginated)
 *   GET    /v1/camt-statements/:id                 — requireOrgAdmin (detail + counts)
 *   GET    /v1/camt-statements/:id/download        — requireOrgAdmin (302 → signed URL)
 *   GET    /v1/camt-unreconciled                   — requireWrite    (review queue)
 *   POST   /v1/camt-unreconciled/:id/resolve       — requireWrite    (link/create/write-off)
 *   GET    /v1/bank-accounts/:id/reconciliation-health — requireOrgAdmin (operator card)
 *
 * The upload endpoint is registered under `/bank-accounts/:id/...`
 * rather than `/camt-statements` because the upload is bound to a bank
 * account (foreign-IBAN safety lives upstream of the worker — see
 * ADR-028 §"Foreign-IBAN safety").
 */

import type { MultipartFile } from "@fastify/multipart";
import {
  CAMT_STATEMENT_STATUS_VALUES,
  CAMT_UNRECONCILED_REASON_VALUES,
  CAMT_UNRECONCILED_STATUS_VALUES,
} from "@givernance/shared/schema";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { requireOrgAdmin, requireWrite } from "../../lib/guards.js";
import { getBankStatementSignedUrl } from "../../lib/s3.js";
import {
  DataArrayResponse,
  DataResponse,
  ErrorResponses,
  IdParams,
  PaginationQuery,
  ProblemDetailSchema,
  problemDetail,
  UuidSchema,
} from "../../lib/schemas.js";
import { getCamtStatement, getReconciliationHealth, listCamtStatements } from "./service.js";
import {
  CamtUnreconciledNotFoundError,
  CamtUnreconciledResolveError,
  listCamtUnreconciled,
  resolveCamtUnreconciled,
} from "./unreconciled-service.js";
import {
  CAMT_UPLOAD_MAX_BYTES,
  CamtUploadValidationError,
  uploadCamtStatement,
} from "./upload-service.js";

// ─── Schemas ────────────────────────────────────────────────────────────────

const CamtStatementStatusSchema = Type.Union(
  CAMT_STATEMENT_STATUS_VALUES.map((v) => Type.Literal(v)),
);

const CamtUnreconciledReasonSchema = Type.Union(
  CAMT_UNRECONCILED_REASON_VALUES.map((v) => Type.Literal(v)),
);
const CamtUnreconciledStatusSchema = Type.Union(
  CAMT_UNRECONCILED_STATUS_VALUES.map((v) => Type.Literal(v)),
);

const CamtStatementSummaryResponse = Type.Object({
  id: UuidSchema,
  msgId: Type.Union([Type.String(), Type.Null()]),
  bankAccountId: UuidSchema,
  status: CamtStatementStatusSchema,
  uploadedAt: Type.String(),
  processedAt: Type.Union([Type.String(), Type.Null()]),
  totalCredits: Type.Integer(),
  matchedCredits: Type.Integer(),
  unmatchedCredits: Type.Integer(),
  statementFrom: Type.Union([Type.String(), Type.Null()]),
  statementTo: Type.Union([Type.String(), Type.Null()]),
  originalFilename: Type.Union([Type.String(), Type.Null()]),
  error: Type.Union([Type.String(), Type.Null()]),
});

const CamtStatementDetailResponse = Type.Object({
  id: UuidSchema,
  msgId: Type.Union([Type.String(), Type.Null()]),
  bankAccountId: UuidSchema,
  status: CamtStatementStatusSchema,
  uploadedAt: Type.String(),
  processedAt: Type.Union([Type.String(), Type.Null()]),
  totalCredits: Type.Integer(),
  matchedCredits: Type.Integer(),
  unmatchedCredits: Type.Integer(),
  statementFrom: Type.Union([Type.String(), Type.Null()]),
  statementTo: Type.Union([Type.String(), Type.Null()]),
  originalFilename: Type.Union([Type.String(), Type.Null()]),
  error: Type.Union([Type.String(), Type.Null()]),
  bankAccount: Type.Union([
    Type.Object({
      id: UuidSchema,
      iban: Type.String(),
      bankName: Type.String(),
      currency: Type.String(),
    }),
    Type.Null(),
  ]),
  creditEntryCount: Type.Integer(),
  unreconciledCount: Type.Integer(),
});

const CamtStatementListQuery = Type.Intersect([
  PaginationQuery,
  Type.Object({
    bankAccountId: Type.Optional(UuidSchema),
    status: Type.Optional(CamtStatementStatusSchema),
  }),
]);

const CamtUploadAcceptedResponse = Type.Object({
  statementId: UuidSchema,
  status: Type.Literal("pending"),
});

const ReconciliationHealthResponse = Type.Object({
  totalStatements: Type.Integer(),
  lastStatementImportedAt: Type.Union([Type.String(), Type.Null()]),
  totalCreditsLastN: Type.Integer(),
  matchedCreditsLastN: Type.Integer(),
  unmatchedCreditsLastN: Type.Integer(),
  totalUnreconciledPending: Type.Integer(),
  recentStatements: Type.Array(CamtStatementSummaryResponse),
});

const CamtUnreconciledRow = Type.Object({
  id: UuidSchema,
  creditEntryId: UuidSchema,
  reason: CamtUnreconciledReasonSchema,
  status: CamtUnreconciledStatusSchema,
  resolvedAt: Type.Union([Type.String(), Type.Null()]),
  resolutionNote: Type.Union([Type.String(), Type.Null()]),
  linkedDonationId: Type.Union([UuidSchema, Type.Null()]),
  createdAt: Type.String(),
  // Credit-entry context — operator needs amount + debtor info to act.
  creditEntry: Type.Object({
    statementId: UuidSchema,
    statementMsgId: Type.Union([Type.String(), Type.Null()]),
    amountCents: Type.Integer(),
    currency: Type.String(),
    structuredRef: Type.Union([Type.String(), Type.Null()]),
    debtorName: Type.Union([Type.String(), Type.Null()]),
    debtorIban: Type.Union([Type.String(), Type.Null()]),
    bankAccountId: UuidSchema,
    valueDate: Type.Union([Type.String(), Type.Null()]),
  }),
});

const CamtUnreconciledListQuery = Type.Intersect([
  PaginationQuery,
  Type.Object({
    bankAccountId: Type.Optional(UuidSchema),
    reason: Type.Optional(CamtUnreconciledReasonSchema),
    status: Type.Optional(CamtUnreconciledStatusSchema),
  }),
]);

const ResolveBody = Type.Object({
  action: Type.Union([
    Type.Literal("link"),
    Type.Literal("create_constituent_and_donation"),
    Type.Literal("write_off"),
  ]),
  resolutionNote: Type.String({ minLength: 1, maxLength: 1000 }),
  donationId: Type.Optional(UuidSchema),
  constituentId: Type.Optional(UuidSchema),
});

// ─── Routes ────────────────────────────────────────────────────────────────

/**
 * Multipart upload handler — extracted from the route closure to keep
 * the closure body under the biome cognitive-complexity ceiling. The
 * caller (`POST /v1/bank-accounts/:id/statements`) just dispatches.
 */
async function handleUploadStatement(
  request: import("fastify").FastifyRequest,
  reply: import("fastify").FastifyReply,
) {
  const orgId = request.auth?.orgId;
  if (!orgId) {
    return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
  }
  const { id: bankAccountId } = request.params as { id: string };

  const fileResult = await readMultipartFile(request);
  if (!fileResult.ok) {
    return reply.status(fileResult.status).send(fileResult.problem);
  }

  try {
    const result = await uploadCamtStatement({
      orgId,
      bankAccountId,
      filename: fileResult.file.filename,
      contentType: fileResult.file.mimetype,
      body: fileResult.buffer,
      uploadedByRowId: request.auth?.userRowId ?? null,
      uploadedByUserId: request.auth?.userId ?? null,
      effectiveActorId: request.auth?.act?.sub ?? null,
    });
    return reply
      .status(202)
      .send({ data: { statementId: result.statementId, status: result.status } });
  } catch (err) {
    if (err instanceof CamtUploadValidationError) {
      if (err.code === "bank_account_not_found") {
        return reply.status(404).send(problemDetail(404, "Not Found", err.message));
      }
      if (err.code === "file_too_large") {
        return reply.status(413).send(problemDetail(413, "Payload Too Large", err.message));
      }
      return reply
        .status(400)
        .send(problemDetail(400, "Bad Request", err.message, { code: err.code }));
    }
    throw err;
  }
}

type MultipartReadResult =
  | { ok: true; file: MultipartFile; buffer: Buffer }
  | {
      ok: false;
      status: 400 | 413;
      problem: ReturnType<typeof problemDetail>;
    };

async function readMultipartFile(
  request: import("fastify").FastifyRequest,
): Promise<MultipartReadResult> {
  let file: MultipartFile | undefined;
  try {
    file = await request.file();
  } catch (err) {
    return {
      ok: false,
      status: 400,
      problem: problemDetail(
        400,
        "Bad Request",
        err instanceof Error ? err.message : "Multipart parse failed",
      ),
    };
  }
  if (!file) {
    return {
      ok: false,
      status: 400,
      problem: problemDetail(400, "Bad Request", "Missing `file` part in multipart upload."),
    };
  }
  let buffer: Buffer;
  try {
    buffer = await file.toBuffer();
  } catch (err) {
    return {
      ok: false,
      status: 413,
      problem: problemDetail(
        413,
        "Payload Too Large",
        err instanceof Error ? err.message : "Upload exceeded size cap",
      ),
    };
  }
  return { ok: true, file, buffer };
}

export async function camtStatementsRoutes(app: FastifyInstance) {
  // ── POST /bank-accounts/:id/statements ──────────────────────────
  app.post(
    "/bank-accounts/:id/statements",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Bank Statements"],
        params: IdParams,
        consumes: ["multipart/form-data"],
        response: {
          ...ErrorResponses,
          202: DataResponse(CamtUploadAcceptedResponse),
          400: ProblemDetailSchema,
          413: ProblemDetailSchema,
        },
      },
      bodyLimit: CAMT_UPLOAD_MAX_BYTES + 1024, // small headroom for multipart envelope
    },
    async (request, reply) => handleUploadStatement(request, reply),
  );

  // ── GET /camt-statements (list) ─────────────────────────────────
  app.get(
    "/camt-statements",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Bank Statements"],
        querystring: CamtStatementListQuery,
        response: {
          200: DataArrayResponse(CamtStatementSummaryResponse),
          ...ErrorResponses,
        },
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
        bankAccountId?: string;
        status?: (typeof CAMT_STATEMENT_STATUS_VALUES)[number];
      };
      const result = await listCamtStatements(orgId, {
        page: query.page ?? 1,
        perPage: query.perPage ?? 20,
        bankAccountId: query.bankAccountId,
        status: query.status,
      });
      return result;
    },
  );

  // ── GET /camt-statements/:id (detail) ───────────────────────────
  app.get(
    "/camt-statements/:id",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Bank Statements"],
        params: IdParams,
        response: { 200: DataResponse(CamtStatementDetailResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const { id } = request.params as { id: string };
      const row = await getCamtStatement(orgId, id);
      if (!row) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Statement not found"));
      }
      // Strip the s3Path before returning — it's internal storage data.
      const { s3Path: _s3, ...rest } = row;
      void _s3;
      return { data: rest };
    },
  );

  // ── GET /camt-statements/:id/download (signed redirect) ─────────
  app.get(
    "/camt-statements/:id/download",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Bank Statements"],
        params: IdParams,
        response: { ...ErrorResponses, 302: Type.Object({}) },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const { id } = request.params as { id: string };
      const row = await getCamtStatement(orgId, id);
      if (!row) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Statement not found"));
      }
      const signedUrl = await getBankStatementSignedUrl({ key: row.s3Path, ttlSec: 300 });
      return reply.redirect(signedUrl, 302);
    },
  );

  // ── GET /bank-accounts/:id/reconciliation-health ────────────────
  app.get(
    "/bank-accounts/:id/reconciliation-health",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Bank Accounts"],
        params: IdParams,
        response: {
          200: DataResponse(ReconciliationHealthResponse),
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
      const health = await getReconciliationHealth(orgId, id);
      if (!health) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Bank account not found"));
      }
      return { data: health };
    },
  );

  // ── GET /camt-unreconciled (list) ───────────────────────────────
  app.get(
    "/camt-unreconciled",
    {
      preHandler: requireWrite,
      schema: {
        tags: ["Bank Statements"],
        querystring: CamtUnreconciledListQuery,
        response: { 200: DataArrayResponse(CamtUnreconciledRow), ...ErrorResponses },
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
        bankAccountId?: string;
        reason?: (typeof CAMT_UNRECONCILED_REASON_VALUES)[number];
        status?: (typeof CAMT_UNRECONCILED_STATUS_VALUES)[number];
      };
      const result = await listCamtUnreconciled(orgId, {
        page: query.page ?? 1,
        perPage: query.perPage ?? 20,
        bankAccountId: query.bankAccountId,
        reason: query.reason,
        status: query.status,
      });
      return result;
    },
  );

  // ── POST /camt-unreconciled/:id/resolve ─────────────────────────
  app.post(
    "/camt-unreconciled/:id/resolve",
    {
      preHandler: requireWrite,
      schema: {
        tags: ["Bank Statements"],
        params: IdParams,
        body: ResolveBody,
        response: {
          ...ErrorResponses,
          200: DataResponse(CamtUnreconciledRow),
          400: ProblemDetailSchema,
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
        action: "link" | "create_constituent_and_donation" | "write_off";
        resolutionNote: string;
        donationId?: string;
        constituentId?: string;
      };

      try {
        const row = await resolveCamtUnreconciled({
          orgId,
          id,
          action: body.action,
          resolutionNote: body.resolutionNote,
          donationId: body.donationId,
          constituentId: body.constituentId,
          resolvedByRowId: request.auth?.userRowId ?? null,
          resolvedByUserId: request.auth?.userId ?? null,
          effectiveActorId: request.auth?.act?.sub ?? null,
        });
        return { data: row };
      } catch (err) {
        if (err instanceof CamtUnreconciledNotFoundError) {
          return reply.status(404).send(problemDetail(404, "Not Found", err.message));
        }
        if (err instanceof CamtUnreconciledResolveError) {
          return reply
            .status(400)
            .send(problemDetail(400, "Bad Request", err.message, { code: err.code }));
        }
        throw err;
      }
    },
  );
}
