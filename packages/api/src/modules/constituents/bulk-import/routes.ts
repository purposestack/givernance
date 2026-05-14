/**
 * Bulk-import routes (Epic #373).
 *
 * Mounted from `constituentRoutes` so they share the `/v1` prefix.
 *
 * Security posture (every route):
 *   - Flag-gated by `FEATURE_FLAG_KEYS.CONSTITUENTS_BULK_IMPORT`. A
 *     disabled flag returns 404 (indistinguishable from a typo'd URL).
 *   - POST also requires `requireWrite`; reads only require `requireAuth`.
 *   - Multipart upload re-asserts the per-route file size cap (10 MB)
 *     at `request.file({ limits: …})` time; the server-level cap is
 *     5 MB for branding so we override here per route.
 *   - Filename sanitisation: `path.basename(name).replace(/[^A-Za-z0-9._-]/g, "_")`
 *     before it touches S3 (key injection / path traversal defence).
 *   - Magic-byte sniff with `file-type` — rejects any payload whose
 *     sniffed type contradicts the claimed mime AND isn't a CSV
 *     (text/plain is the common false-negative for `file-type`).
 */

import { basename } from "node:path";
import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { fileTypeFromBuffer } from "file-type";
import { requireFlag } from "../../../lib/flags/flag-guard.js";
import { requireAuth, requireWrite } from "../../../lib/guards.js";
import { getBulkImportObject } from "../../../lib/s3.js";
import {
  DataArrayResponse,
  DataResponse,
  ErrorResponses,
  IdParams,
  PaginationQuery,
  PaginationSchema,
  ProblemDetailSchema,
  problemDetail,
  UuidSchema,
} from "../../../lib/schemas.js";
import {
  BulkImportValidationError,
  dispatchBulkImport,
  getBulkImportFileForJob,
  getBulkImportJob,
  listBulkImportJobs,
  listBulkImportResults,
} from "./service.js";
import { buildImportTemplateCsv, TEMPLATE_FILENAME } from "./template.js";

const MAX_BULK_IMPORT_BYTES = 10 * 1024 * 1024;
const ACCEPTED_MIME_TYPES = new Set([
  "text/csv",
  "application/csv",
  "text/plain",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/octet-stream", // some browsers fall back to this for .xlsx
]);

const JobStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("processing"),
  Type.Literal("completed"),
  Type.Literal("partial"),
  Type.Literal("failed"),
]);

const ResultStatusSchema = Type.Union([
  Type.Literal("created"),
  Type.Literal("duplicate"),
  Type.Literal("failed"),
]);

const BulkImportJobRowSchema = Type.Object({
  id: UuidSchema,
  status: JobStatusSchema,
  totalRows: Type.Integer(),
  processedRows: Type.Integer(),
  createdCount: Type.Integer(),
  duplicateCount: Type.Integer(),
  failedCount: Type.Integer(),
  completeAddressCount: Type.Integer(),
  emailCount: Type.Integer(),
  fileId: UuidSchema,
  requestedBy: Type.Union([Type.Null(), UuidSchema]),
  error: Type.Union([Type.Null(), Type.String()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  completedAt: Type.Union([Type.Null(), Type.String()]),
});

const BulkImportResultRowSchema = Type.Object({
  id: UuidSchema,
  rowNumber: Type.Integer(),
  status: ResultStatusSchema,
  constituentId: Type.Union([Type.Null(), UuidSchema]),
  duplicateOfId: Type.Union([Type.Null(), UuidSchema]),
  duplicateScore: Type.Union([Type.Null(), Type.String()]),
  errorCode: Type.Union([Type.Null(), Type.String()]),
  errorMessage: Type.Union([Type.Null(), Type.String()]),
  rowData: Type.Record(Type.String(), Type.Unknown()),
  createdAt: Type.String(),
});

const UploadResponseSchema = Type.Object({
  jobId: UuidSchema,
  status: JobStatusSchema,
  totalRows: Type.Integer(),
});

const ResultsQuery = Type.Intersect([
  PaginationQuery,
  Type.Object({ status: Type.Optional(ResultStatusSchema) }),
]);

/**
 * Pre-canonicalise the uploaded filename. Path traversal and key
 * injection defence:
 *   - `basename(name)` strips any leading directory components.
 *   - The character class allows only filename-safe ASCII; anything
 *     else (spaces, Unicode, control chars) becomes `_`.
 *   - Empty result falls back to `import` so an entirely-special-char
 *     filename still produces a valid S3 key.
 */
function sanitiseFilename(input: string): string {
  const base = basename(input);
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^_+/, "")
    .replace(/_+$/, "");
  return cleaned.length > 0 ? cleaned.slice(0, 200) : "import";
}

interface MultipartFileLike {
  toBuffer: () => Promise<Buffer>;
  mimetype?: string;
  filename?: string;
}

interface AcceptedUpload {
  buffer: Buffer;
  fileName: string;
  effectiveMime: "text/csv" | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
}

type ProblemResponse = { status: number; problem: ReturnType<typeof problemDetail> };

function problem(
  status: number,
  title: string,
  detail: string,
  ext?: Record<string, unknown>,
): ProblemResponse {
  return { status, problem: problemDetail(status, title, detail, ext) };
}

async function readUploadBuffer(file: MultipartFileLike): Promise<Buffer | ProblemResponse> {
  try {
    return await file.toBuffer();
  } catch (err) {
    if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
      return problem(413, "Payload Too Large", "Upload exceeds the 10 MB limit");
    }
    return problem(400, "Bad Request", "Failed to read upload");
  }
}

/**
 * Decide the effective MIME type from the claim + the file-type sniff.
 * Returns `null` when the upload should be rejected.
 */
function decideMime(
  claimed: string,
  sniffed: string | undefined,
  fileName: string,
): "text/csv" | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" | null {
  const lower = claimed.toLowerCase();
  const sniffLower = sniffed?.toLowerCase();
  const isCsvName = /\.csv$/i.test(fileName);
  const isXlsxName = /\.xlsx$/i.test(fileName);

  // CSV: `file-type` can't sniff text formats, so accept by extension /
  // claimed mime when the sniff returned undefined OR a plain-text result.
  if (
    isCsvName &&
    (sniffLower === undefined || sniffLower === "text/plain" || lower.includes("csv"))
  ) {
    return "text/csv";
  }

  // XLSX: `file-type` recognises this as the ZIP-OOXML signature.
  if (
    sniffLower === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    (isXlsxName && sniffLower === "application/zip")
  ) {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }

  return null;
}

/**
 * Pull the multipart file from the request, sniff its mime, and run
 * every defensive check (size, accepted-claim list, file-type match).
 * Returns either a normalised payload ready for `dispatchBulkImport`
 * or a structured problem response.
 *
 * Extracted from the route handler so its cognitive complexity stays
 * under the Biome ceiling.
 */
async function acceptUpload(
  // biome-ignore lint/suspicious/noExplicitAny: @fastify/multipart augments FastifyRequest at runtime
  reqWithFile: any,
): Promise<AcceptedUpload | ProblemResponse> {
  if (typeof reqWithFile.file !== "function") {
    return problem(400, "Bad Request", "Endpoint expects a multipart/form-data body");
  }
  const file: MultipartFileLike | null = await reqWithFile.file({
    limits: { fileSize: MAX_BULK_IMPORT_BYTES, files: 1 },
  });
  if (!file) {
    return problem(400, "Bad Request", "Multipart request missing `file` field");
  }

  const bufferOrProblem = await readUploadBuffer(file);
  if (!Buffer.isBuffer(bufferOrProblem)) {
    return bufferOrProblem as ProblemResponse;
  }
  const buffer: Buffer = bufferOrProblem;

  if (buffer.byteLength > MAX_BULK_IMPORT_BYTES) {
    return problem(413, "Payload Too Large", "Upload exceeds the 10 MB limit");
  }

  const claimedMime = file.mimetype ?? "";
  if (claimedMime && !ACCEPTED_MIME_TYPES.has(claimedMime.toLowerCase())) {
    return problem(415, "Unsupported Media Type", "Only CSV and XLSX uploads are supported", {
      claimed_mime: claimedMime,
    });
  }

  const fileName = sanitiseFilename(file.filename ?? "import");
  const sniff = await fileTypeFromBuffer(buffer);
  const effectiveMime = decideMime(claimedMime, sniff?.mime, fileName);
  if (!effectiveMime) {
    return problem(
      415,
      "Unsupported Media Type",
      "File contents did not match a supported format (CSV or XLSX)",
      { claimed_mime: claimedMime, sniffed_mime: sniff?.mime ?? null },
    );
  }

  return { buffer, fileName, effectiveMime };
}

export async function registerBulkImportRoutes(app: FastifyInstance) {
  // ── POST /constituents/bulk-import ─────────────────────────────────────
  app.post(
    "/constituents/bulk-import",
    {
      preHandler: [
        requireFlag(FEATURE_FLAG_KEYS.CONSTITUENTS_BULK_IMPORT),
        requireAuth,
        requireWrite,
      ],
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        tags: ["Constituents"],
        consumes: ["multipart/form-data"],
        response: {
          202: DataResponse(UploadResponseSchema),
          400: ProblemDetailSchema,
          413: ProblemDetailSchema,
          415: ProblemDetailSchema,
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

      const accepted = await acceptUpload(request as unknown);
      if ("status" in accepted) {
        return reply.status(accepted.status).send(accepted.problem);
      }

      try {
        const result = await dispatchBulkImport(
          orgId,
          userId,
          {
            fileBuffer: accepted.buffer,
            fileName: accepted.fileName,
            mimeType: accepted.effectiveMime,
          },
          request,
        );
        reply.header("Location", `/v1/constituents/bulk-import/${result.jobId}`);
        return reply.status(202).send({
          data: { jobId: result.jobId, status: "pending" as const, totalRows: result.totalRows },
        });
      } catch (err) {
        if (err instanceof BulkImportValidationError) {
          // Distinguish file-size / row-cap (413) from validation (400)
          // so the UI can branch on status code without parsing the body.
          const tooLargeCodes = new Set(["FILE_TOO_LARGE", "TOO_MANY_ROWS"]);
          const status = tooLargeCodes.has(err.code) ? 413 : 400;
          return reply.status(status).send(problemDetail(status, err.code, err.message));
        }
        request.log.error(
          { err: err instanceof Error ? err.message : String(err), orgId },
          "bulk-import: dispatch failed",
        );
        return reply
          .status(500)
          .send(problemDetail(500, "Internal Server Error", "Bulk import dispatch failed"));
      }
    },
  );

  // ── GET /constituents/bulk-import/template ─────────────────────────────
  // Note: this MUST register BEFORE the `:id` route so Fastify doesn't
  // try to match "template" as a UUID param.
  app.get(
    "/constituents/bulk-import/template",
    {
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.CONSTITUENTS_BULK_IMPORT), requireAuth],
      schema: {
        tags: ["Constituents"],
        response: { 200: Type.String(), ...ErrorResponses },
      },
    },
    async (_request, reply) => {
      const body = buildImportTemplateCsv();
      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename="${TEMPLATE_FILENAME}"`);
      // Avoid CDN / browser caching — the template can evolve and we
      // don't want stale columns in operator hands.
      reply.header("Cache-Control", "no-store");
      return reply.send(body);
    },
  );

  // ── GET /constituents/bulk-import (list) ───────────────────────────────
  app.get(
    "/constituents/bulk-import",
    {
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.CONSTITUENTS_BULK_IMPORT), requireAuth],
      // Cap polling cadence so a buggy client (multiple tabs, runaway
      // useEffect) can't hammer the list endpoint.
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["Constituents"],
        querystring: PaginationQuery,
        response: {
          200: DataArrayResponse(BulkImportJobRowSchema),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const q = request.query as { page?: number; perPage?: number };
      const page = q.page ?? 1;
      const perPage = q.perPage ?? 20;
      const { data, total } = await listBulkImportJobs(orgId, { page, perPage });
      return {
        data,
        pagination: {
          page,
          perPage,
          total,
          totalPages: Math.max(1, Math.ceil(total / perPage)),
        },
      };
    },
  );

  // ── GET /constituents/bulk-import/:id ──────────────────────────────────
  app.get(
    "/constituents/bulk-import/:id",
    {
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.CONSTITUENTS_BULK_IMPORT), requireAuth],
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["Constituents"],
        params: IdParams,
        response: { 200: DataResponse(BulkImportJobRowSchema), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const { id } = request.params as { id: string };
      const row = await getBulkImportJob(orgId, id);
      if (!row) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Bulk import job not found"));
      }
      return { data: row };
    },
  );

  // ── GET /constituents/bulk-import/:id/results ──────────────────────────
  app.get(
    "/constituents/bulk-import/:id/results",
    {
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.CONSTITUENTS_BULK_IMPORT), requireAuth],
      schema: {
        tags: ["Constituents"],
        params: IdParams,
        querystring: ResultsQuery,
        response: {
          200: Type.Object({
            data: Type.Array(BulkImportResultRowSchema),
            pagination: PaginationSchema,
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
      const q = request.query as {
        page?: number;
        perPage?: number;
        status?: "created" | "duplicate" | "failed";
      };
      const page = q.page ?? 1;
      const perPage = q.perPage ?? 50;
      const out = await listBulkImportResults(orgId, id, {
        page,
        perPage,
        status: q.status,
      });
      if (!out) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Bulk import job not found"));
      }
      return {
        data: out.data,
        pagination: {
          page,
          perPage,
          total: out.total,
          totalPages: Math.max(1, Math.ceil(out.total / perPage)),
        },
      };
    },
  );

  // ── GET /constituents/bulk-import/:id/download ─────────────────────────
  app.get(
    "/constituents/bulk-import/:id/download",
    {
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.CONSTITUENTS_BULK_IMPORT), requireAuth],
      schema: {
        tags: ["Constituents"],
        params: IdParams,
        response: { ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const { id } = request.params as { id: string };

      const file = await getBulkImportFileForJob(orgId, id);
      if (!file) {
        return reply
          .status(404)
          .send(problemDetail(404, "Not Found", "Bulk import file not found"));
      }

      try {
        const { body, contentLength } = await getBulkImportObject(file.s3Key);
        reply.header("Content-Type", file.mimeType);
        // The filename was already sanitised on upload, but re-quote
        // here defensively so a `"` in a legacy filename can't break
        // the header.
        const safe = file.fileName.replace(/"/g, "");
        reply.header("Content-Disposition", `attachment; filename="${safe}"`);
        if (contentLength != null) reply.header("Content-Length", String(contentLength));
        reply.header("Cache-Control", "private, no-store");
        return reply.send(body);
      } catch (err) {
        request.log.error(
          { err: err instanceof Error ? err.message : String(err), jobId: id },
          "bulk-import: file fetch failed",
        );
        return reply
          .status(404)
          .send(problemDetail(404, "Not Found", "Bulk import file not found"));
      }
    },
  );
}
