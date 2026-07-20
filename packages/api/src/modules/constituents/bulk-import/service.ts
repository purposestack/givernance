/**
 * Bulk-import service (Epic #373).
 *
 * Owns the HTTP-side workflow: upload to S3, INSERT the file + job rows
 * + outbox event in one transaction, return the job id. The actual
 * row-by-row work happens in the BullMQ processor.
 *
 * Trade-off — DB first vs S3 first:
 *   We upload to S3 FIRST, then run the DB transaction. Rationale:
 *     - If the DB txn fails, we have an orphan S3 object → cleaned up
 *       below in the catch path (best-effort `deleteBulkImportObject`).
 *     - If S3 fails, the request returns 500 BEFORE any DB row exists
 *       — operator sees a clean failure, no half-state.
 *   The bulk-email path goes "DB first" because the worker only needs
 *   the row. Bulk-import is different: the worker MUST be able to read
 *   the file from S3, so the file existing is a precondition for the
 *   row being meaningful.
 */

import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import { CUSTOM_FIELDS_IMPORT_TEMPLATE_VERSION } from "@givernance/shared/custom-fields";
import type { OutboxMetadata } from "@givernance/shared/schema";
import { bulkImportFiles, bulkImportJobs, outboxEvents } from "@givernance/shared/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { withTenantContext } from "../../../lib/db.js";
import { flagService } from "../../../lib/flags/flag-service.js";
import { resolveInternalUserId } from "../../../lib/resolve-user.js";
import { deleteBulkImportObject, putBulkImportObject } from "../../../lib/s3.js";
import { buildOutboxMetadata } from "../../../lib/trace-context.js";
import { getActiveDefinitions } from "../../customization/lib/value-service.js";
import { BulkImportParseError, MAX_BULK_IMPORT_ROWS, parseBulkImportFile } from "./parser.js";

export class BulkImportValidationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "BulkImportValidationError";
  }
}

export interface DispatchBulkImportInput {
  fileBuffer: Buffer;
  fileName: string;
  mimeType: string;
}

export interface DispatchBulkImportResult {
  jobId: string;
  totalRows: number;
}

/**
 * Build the S3 key for a bulk-import upload. The `{org_id}/bulk-imports/
 * {job_id}/…` shape is the per-tenant isolation boundary in the private
 * bucket (ADR-023: per-tenant isolation lives in the prefix, not in
 * object ACLs).
 */
function buildS3Key(orgId: string, jobId: string, fileName: string): string {
  return `${orgId}/bulk-imports/${jobId}/${fileName}`;
}

/**
 * Pre-validate the file before persisting anything. Catches:
 *   - Missing required headers (firstName/lastName).
 *   - Empty file.
 *   - Row count over the cap.
 *   - Unreadable CSV / XLSX.
 * The HTTP route surfaces the structured error code as a 400 — the
 * operator sees a precise message instead of a generic upload failure.
 *
 * The full parse output (rows + headers) is NOT stored anywhere here
 * — the worker re-parses the file under its own context. We just
 * count rows for the `bulk_import_jobs.total_rows` column.
 */
async function preParseForRowCount(
  fileBuffer: Buffer,
  mimeType: string,
  fileName: string,
): Promise<number> {
  const parsed = await parseBulkImportFile(fileBuffer, mimeType, fileName);
  return parsed.rows.length;
}

/**
 * Dispatch a new bulk-import job. Inserts the file row, the job row,
 * and the outbox event in one transaction so a partial failure can't
 * leave a job without an outbox tick (or vice-versa).
 *
 * The randomly-generated job id is used as the S3 key prefix so we can
 * upload to a known path BEFORE the row insert — the order is
 *   1. compute jobId (UUID, client-side via Postgres later via .returning())
 *   2. upload to S3 with that jobId as the key prefix
 *   3. INSERT both rows + outbox event with the same jobId
 * To make step 1 deterministic without round-tripping the DB, we
 * pre-generate the UUID in JS (`crypto.randomUUID`).
 */
export async function dispatchBulkImport(
  orgId: string,
  userId: string,
  input: DispatchBulkImportInput,
  request?: FastifyRequest,
): Promise<DispatchBulkImportResult> {
  // Reject 0-byte and oversized inputs defensively — the route also caps
  // via `request.file({ limits: { fileSize: 10 MB } })` but we double-check
  // so a future caller (internal tooling, tests) can't bypass the route guard.
  if (input.fileBuffer.byteLength === 0) {
    throw new BulkImportValidationError("Uploaded file is empty", "EMPTY_FILE");
  }
  if (input.fileBuffer.byteLength > 10 * 1024 * 1024) {
    throw new BulkImportValidationError("Uploaded file exceeds the 10MB limit", "FILE_TOO_LARGE");
  }

  // Synchronous pre-parse — fails early on missing required columns so
  // the operator sees the precise error in the upload modal instead of
  // a confused worker complaint 5s later.
  let totalRows: number;
  try {
    totalRows = await preParseForRowCount(input.fileBuffer, input.mimeType, input.fileName);
  } catch (err) {
    if (err instanceof BulkImportParseError) {
      throw new BulkImportValidationError(err.message, err.code);
    }
    throw err;
  }

  if (totalRows === 0) {
    throw new BulkImportValidationError("File contains no data rows", "EMPTY_FILE");
  }
  if (totalRows > MAX_BULK_IMPORT_ROWS) {
    throw new BulkImportValidationError(
      `File exceeds the ${MAX_BULK_IMPORT_ROWS}-row limit`,
      "TOO_MANY_ROWS",
    );
  }

  const metadata: OutboxMetadata | null = request ? buildOutboxMetadata(request) : null;

  // Epic #539 — record on `bulk_import_files` which template generation
  // this upload was made against: '1.1' when the tenant's custom-fields
  // flag is on AND the org has active constituent definitions (i.e. the
  // served template carried `cf_<key>` columns). Observability only —
  // the worker resolves custom headers from the live flag + catalog, so
  // a stale '1.0' file uploaded after the flag flips still imports.
  let templateVersion = "1.0";
  if (await flagService.isEnabled(FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS, { orgId })) {
    const customDefs = await getActiveDefinitions(orgId, "constituent");
    if (customDefs.length > 0) {
      templateVersion = CUSTOM_FIELDS_IMPORT_TEMPLATE_VERSION;
    }
  }

  // Pre-generate job id so we can compute the S3 key BEFORE the insert.
  const jobId = globalThis.crypto.randomUUID();
  const s3Key = buildS3Key(orgId, jobId, input.fileName);

  let bucket: string;
  try {
    const result = await putBulkImportObject(s3Key, input.fileBuffer, input.mimeType);
    bucket = result.bucket;
  } catch (err) {
    throw new Error(
      `Failed to upload bulk-import file to object storage: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }

  try {
    return await withTenantContext(orgId, async (tx) => {
      const requestedByInternal = await resolveInternalUserId(tx, orgId, userId);

      const [fileRow] = await tx
        .insert(bulkImportFiles)
        .values({
          orgId,
          s3Key,
          s3Bucket: bucket,
          fileName: input.fileName,
          fileSize: input.fileBuffer.byteLength,
          mimeType: input.mimeType,
          templateVersion,
        })
        .returning({ id: bulkImportFiles.id });

      if (!fileRow) {
        throw new Error("Failed to insert bulk_import_files row");
      }

      const [job] = await tx
        .insert(bulkImportJobs)
        .values({
          id: jobId,
          orgId,
          status: "pending",
          totalRows,
          fileId: fileRow.id,
          requestedBy: requestedByInternal,
        })
        .returning({ id: bulkImportJobs.id });

      if (!job) {
        throw new Error("Failed to insert bulk_import_jobs row");
      }

      await tx.insert(outboxEvents).values({
        tenantId: orgId,
        type: "constituents.bulk_import_requested",
        metadata,
        payload: {
          bulkImportJobId: job.id,
          requestedBy: userId,
        },
      });

      return { jobId: job.id, totalRows };
    });
  } catch (err) {
    // Compensation: best-effort clean up the orphan S3 object so the
    // bucket doesn't accumulate dead uploads if the DB rolls back.
    try {
      await deleteBulkImportObject(s3Key);
    } catch (cleanupErr) {
      request?.log.warn(
        { err: cleanupErr, s3Key },
        "bulk-import: failed to clean up orphan S3 object after DB rollback",
      );
    }
    throw err;
  }
}

// ─── Read-side helpers ──────────────────────────────────────────────────────

export interface BulkImportJobView {
  id: string;
  status: "pending" | "processing" | "completed" | "partial" | "failed";
  totalRows: number;
  processedRows: number;
  createdCount: number;
  duplicateCount: number;
  failedCount: number;
  completeAddressCount: number;
  emailCount: number;
  fileId: string;
  requestedBy: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function mapJob(row: {
  id: string;
  status: BulkImportJobView["status"];
  totalRows: number;
  processedRows: number;
  createdCount: number;
  duplicateCount: number;
  failedCount: number;
  completeAddressCount: number;
  emailCount: number;
  fileId: string;
  requestedBy: string | null;
  error: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  completedAt: Date | string | null;
}): BulkImportJobView {
  return {
    id: row.id,
    status: row.status,
    totalRows: row.totalRows,
    processedRows: row.processedRows,
    createdCount: row.createdCount,
    duplicateCount: row.duplicateCount,
    failedCount: row.failedCount,
    completeAddressCount: row.completeAddressCount,
    emailCount: row.emailCount,
    fileId: row.fileId,
    requestedBy: row.requestedBy,
    error: row.error,
    // biome-ignore lint/style/noNonNullAssertion: Drizzle returns Date for non-null timestamp columns
    createdAt: toIso(row.createdAt)!,
    // biome-ignore lint/style/noNonNullAssertion: same
    updatedAt: toIso(row.updatedAt)!,
    completedAt: toIso(row.completedAt),
  };
}

export interface ListBulkImportJobsQuery {
  page: number;
  perPage: number;
}

export async function listBulkImportJobs(
  orgId: string,
  query: ListBulkImportJobsQuery,
): Promise<{ data: BulkImportJobView[]; total: number }> {
  return withTenantContext(orgId, async (tx) => {
    const offset = (query.page - 1) * query.perPage;
    const [rows, countResult] = await Promise.all([
      tx
        .select({
          id: bulkImportJobs.id,
          status: bulkImportJobs.status,
          totalRows: bulkImportJobs.totalRows,
          processedRows: bulkImportJobs.processedRows,
          createdCount: bulkImportJobs.createdCount,
          duplicateCount: bulkImportJobs.duplicateCount,
          failedCount: bulkImportJobs.failedCount,
          completeAddressCount: bulkImportJobs.completeAddressCount,
          emailCount: bulkImportJobs.emailCount,
          fileId: bulkImportJobs.fileId,
          requestedBy: bulkImportJobs.requestedBy,
          error: bulkImportJobs.error,
          createdAt: bulkImportJobs.createdAt,
          updatedAt: bulkImportJobs.updatedAt,
          completedAt: bulkImportJobs.completedAt,
        })
        .from(bulkImportJobs)
        .where(and(eq(bulkImportJobs.orgId, orgId), isNull(bulkImportJobs.deletedAt)))
        .orderBy(sql`${bulkImportJobs.createdAt} DESC`)
        .limit(query.perPage)
        .offset(offset),
      tx
        .select({ count: sql<number>`count(*)` })
        .from(bulkImportJobs)
        .where(and(eq(bulkImportJobs.orgId, orgId), isNull(bulkImportJobs.deletedAt))),
    ]);
    const total = Number(countResult[0]?.count ?? 0);
    return { data: rows.map(mapJob), total };
  });
}

export async function getBulkImportJob(
  orgId: string,
  jobId: string,
): Promise<BulkImportJobView | null> {
  return withTenantContext(orgId, async (tx) => {
    const [row] = await tx
      .select({
        id: bulkImportJobs.id,
        status: bulkImportJobs.status,
        totalRows: bulkImportJobs.totalRows,
        processedRows: bulkImportJobs.processedRows,
        createdCount: bulkImportJobs.createdCount,
        duplicateCount: bulkImportJobs.duplicateCount,
        failedCount: bulkImportJobs.failedCount,
        completeAddressCount: bulkImportJobs.completeAddressCount,
        emailCount: bulkImportJobs.emailCount,
        fileId: bulkImportJobs.fileId,
        requestedBy: bulkImportJobs.requestedBy,
        error: bulkImportJobs.error,
        createdAt: bulkImportJobs.createdAt,
        updatedAt: bulkImportJobs.updatedAt,
        completedAt: bulkImportJobs.completedAt,
      })
      .from(bulkImportJobs)
      .where(
        and(
          eq(bulkImportJobs.id, jobId),
          eq(bulkImportJobs.orgId, orgId),
          isNull(bulkImportJobs.deletedAt),
        ),
      );
    return row ? mapJob(row) : null;
  });
}

export interface BulkImportResultView {
  id: string;
  rowNumber: number;
  status: "created" | "duplicate" | "failed";
  constituentId: string | null;
  duplicateOfId: string | null;
  duplicateScore: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  rowData: Record<string, unknown>;
  createdAt: string;
}

export interface ListBulkImportResultsQuery {
  page: number;
  perPage: number;
  status?: "created" | "duplicate" | "failed";
}

export async function listBulkImportResults(
  orgId: string,
  jobId: string,
  query: ListBulkImportResultsQuery,
): Promise<{ data: BulkImportResultView[]; total: number } | null> {
  // Authorise: the job must belong to this tenant. We rely on RLS for
  // isolation but also explicit `orgId` predicates so a stray query
  // outside withTenantContext can't fall through to a cross-tenant read.
  return withTenantContext(orgId, async (tx) => {
    const [job] = await tx
      .select({ id: bulkImportJobs.id })
      .from(bulkImportJobs)
      .where(
        and(
          eq(bulkImportJobs.id, jobId),
          eq(bulkImportJobs.orgId, orgId),
          isNull(bulkImportJobs.deletedAt),
        ),
      );
    if (!job) return null;

    const offset = (query.page - 1) * query.perPage;
    const filters = [
      sql`org_id = ${orgId}`,
      sql`job_id = ${jobId}`,
      ...(query.status ? [sql`status = ${query.status}`] : []),
    ];
    const where = sql.join(filters, sql` AND `);

    const [rowsResult, countResult] = await Promise.all([
      tx.execute(sql`
        SELECT id, row_number AS "rowNumber", status, constituent_id AS "constituentId",
          duplicate_of_id AS "duplicateOfId", duplicate_score AS "duplicateScore",
          error_code AS "errorCode", error_message AS "errorMessage", row_data AS "rowData",
          created_at AS "createdAt"
        FROM bulk_import_results
        WHERE ${where}
        ORDER BY row_number ASC
        LIMIT ${query.perPage}
        OFFSET ${offset}
      `),
      tx.execute(sql`
        SELECT COUNT(*)::int AS count FROM bulk_import_results WHERE ${where}
      `),
    ]);

    const rows = rowsResult.rows as Array<{
      id: string;
      rowNumber: number;
      status: "created" | "duplicate" | "failed";
      constituentId: string | null;
      duplicateOfId: string | null;
      duplicateScore: string | null;
      errorCode: string | null;
      errorMessage: string | null;
      rowData: Record<string, unknown>;
      createdAt: Date | string;
    }>;
    const total = Number((countResult.rows[0] as { count?: number } | undefined)?.count ?? 0);

    return {
      data: rows.map((r) => ({
        ...r,
        // biome-ignore lint/style/noNonNullAssertion: created_at is NOT NULL in the schema
        createdAt: toIso(r.createdAt)!,
      })),
      total,
    };
  });
}

export interface BulkImportFileView {
  s3Key: string;
  s3Bucket: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
}

/** Used by the download route — looks up `bulk_import_files` via the job id. */
export async function getBulkImportFileForJob(
  orgId: string,
  jobId: string,
): Promise<BulkImportFileView | null> {
  return withTenantContext(orgId, async (tx) => {
    const [row] = await tx
      .select({
        s3Key: bulkImportFiles.s3Key,
        s3Bucket: bulkImportFiles.s3Bucket,
        fileName: bulkImportFiles.fileName,
        mimeType: bulkImportFiles.mimeType,
        fileSize: bulkImportFiles.fileSize,
      })
      .from(bulkImportJobs)
      .innerJoin(bulkImportFiles, eq(bulkImportFiles.id, bulkImportJobs.fileId))
      .where(
        and(
          eq(bulkImportJobs.id, jobId),
          eq(bulkImportJobs.orgId, orgId),
          isNull(bulkImportJobs.deletedAt),
        ),
      );
    return row ?? null;
  });
}
