/**
 * Bulk-import processor (Epic #373).
 *
 * Input: `bulkImportJobId` referencing a `bulk_import_jobs` row. The
 * worker:
 *   1. Loads the row + transitions it to `processing` (idempotent — a
 *      duplicate retry against an already-terminal row exits early).
 *   2. Downloads the source file from S3 under tenant RLS context.
 *   3. Re-parses the file (formula injection neutralised, formula cells
 *      rejected — see parser comments) and walks rows in batches of 50.
 *   4. Per row: validates → checks duplicates → INSERTs constituent →
 *      writes a `bulk_import_results` row → bumps counters via SQL
 *      increments on `bulk_import_jobs` (single UPDATE per batch).
 *   5. Finalises status: `completed` if every row created without
 *      failure, `partial` if any duplicates/failures, `failed` only on
 *      an unrecoverable worker-level error.
 *   6. Writes one `audit_logs` row with action
 *      `constituents.bulk_import.completed` (GDPR Art. 5(2)).
 *
 * Lockstep duplicate of `packages/api/src/modules/constituents/bulk-
 * import/parser.ts` + `validation.ts` — the cross-package import
 * direction (worker → api) is forbidden by the repo convention, so the
 * parse + validation logic is reimplemented here on the worker side.
 * Keep the two copies in sync; a future refactor can move both into
 * `packages/shared` once the csv-parse / exceljs deps land there.
 */

import type { Readable } from "node:stream";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import type { ProcessBulkImportJob } from "@givernance/shared/jobs";
import {
  auditLogs,
  bulkImportFiles,
  bulkImportJobs,
  bulkImportResults,
  constituents,
} from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { parse as parseCsvSync } from "csv-parse/sync";
import { and, eq, isNull, sql } from "drizzle-orm";
import ExcelJS from "exceljs";
import { env } from "../env.js";
import { withWorkerContext } from "../lib/db.js";
import { isFlagEnabled, isFlagEnabledForTenant } from "../lib/flags.js";
import { jobLogger } from "../lib/logger.js";

const BATCH_SIZE = 50;
const MAX_ROWS = 50_000;

// ─── S3 client (worker) ─────────────────────────────────────────────────────
// The worker package doesn't have a shared S3 helper for bulk-import yet
// (the API-side helpers live in packages/api). One client instance per
// worker process is fine — node-pg-style pooling is internal to the SDK.

const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  forcePathStyle: true,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
});

async function downloadFile(bucket: string, key: string): Promise<Buffer> {
  const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = out.Body as Readable | undefined;
  if (!body) {
    throw new Error(`S3 object missing body: ${bucket}/${key}`);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

// ─── Parser (lockstep with API parser.ts) ───────────────────────────────────

const CANONICAL_HEADERS = [
  "firstName",
  "lastName",
  "email",
  "phone",
  "addressLine1",
  "addressLine2",
  "postalCode",
  "city",
  "countryCode",
  "type",
  "tags",
] as const;
type CanonicalHeader = (typeof CANONICAL_HEADERS)[number];

const HEADER_ALIASES: Record<string, CanonicalHeader> = {
  firstname: "firstName",
  first_name: "firstName",
  "first-name": "firstName",
  "first name": "firstName",
  prenom: "firstName",
  prénom: "firstName",
  lastname: "lastName",
  last_name: "lastName",
  "last-name": "lastName",
  "last name": "lastName",
  surname: "lastName",
  nom: "lastName",
  email: "email",
  "e-mail": "email",
  mail: "email",
  courriel: "email",
  phone: "phone",
  telephone: "phone",
  téléphone: "phone",
  tel: "phone",
  mobile: "phone",
  addressline1: "addressLine1",
  address_line_1: "addressLine1",
  "address-line-1": "addressLine1",
  "address line 1": "addressLine1",
  address1: "addressLine1",
  address: "addressLine1",
  adresse: "addressLine1",
  addressline2: "addressLine2",
  address_line_2: "addressLine2",
  "address-line-2": "addressLine2",
  "address line 2": "addressLine2",
  address2: "addressLine2",
  postalcode: "postalCode",
  postal_code: "postalCode",
  "postal-code": "postalCode",
  "postal code": "postalCode",
  zip: "postalCode",
  zipcode: "postalCode",
  cp: "postalCode",
  "code postal": "postalCode",
  city: "city",
  ville: "city",
  town: "city",
  countrycode: "countryCode",
  country_code: "countryCode",
  "country-code": "countryCode",
  "country code": "countryCode",
  country: "countryCode",
  pays: "countryCode",
  type: "type",
  "constituent type": "type",
  tags: "tags",
  labels: "tags",
};

function normaliseHeader(raw: string): CanonicalHeader | null {
  const cleaned = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (!cleaned) return null;
  for (const c of CANONICAL_HEADERS) if (cleaned === c.toLowerCase()) return c;
  return HEADER_ALIASES[cleaned] ?? null;
}

function neutraliseFormula(value: string): string {
  if (!value) return value;
  const first = value.charCodeAt(0);
  if (
    first === 0x3d ||
    first === 0x2b ||
    first === 0x2d ||
    first === 0x40 ||
    first === 0x09 ||
    first === 0x0d
  ) {
    return `'${value}`;
  }
  return value;
}

function fromCellString(value: string): string | null {
  const t = value.trim();
  return t === "" ? null : neutraliseFormula(t);
}

function fromCellObject(obj: Record<string, unknown>): string | null {
  if ("formula" in obj) {
    const e = new Error("Formula cells are not supported");
    (e as Error & { code: string }).code = "INVALID_CELL";
    throw e;
  }
  if (typeof obj.text === "string") return fromCellString(obj.text);
  if (typeof obj.result === "string") return fromCellString(obj.result);
  return null;
}

function cellToString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return fromCellString(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return fromCellObject(value as Record<string, unknown>);
  return null;
}

interface ParsedRow {
  rowNumber: number;
  values: Record<string, string>;
  /** Per-row parse error (e.g. INVALID_CELL on a formula). Forwarded as a failure if set. */
  parseError?: { code: string; message: string };
}

function parseCsvBuffer(buffer: Buffer): ParsedRow[] {
  const records = parseCsvSync(buffer, {
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
    trim: false,
  }) as string[][];
  if (records.length === 0) return [];
  const headerRow = records[0] ?? [];
  const headerKeys = headerRow.map((h) => normaliseHeader(h ?? ""));
  const rows: ParsedRow[] = [];
  const dataRows = records.slice(1, 1 + MAX_ROWS);
  for (let i = 0; i < dataRows.length; i++) {
    const cols = dataRows[i] ?? [];
    const values: Record<string, string> = {};
    for (let j = 0; j < headerKeys.length; j++) {
      const k = headerKeys[j];
      if (!k) continue;
      const v = cols[j];
      const norm = cellToString(v);
      if (norm !== null) values[k] = norm;
    }
    rows.push({ rowNumber: i + 1, values });
  }
  return rows;
}

function extractHeaderKeysXlsx(values: unknown[]): (CanonicalHeader | null)[] {
  const keys: (CanonicalHeader | null)[] = [];
  for (let col = 1; col < values.length; col++) {
    const raw = values[col];
    const text = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
    keys.push(normaliseHeader(text));
  }
  return keys;
}

function extractXlsxRow(
  cells: unknown[],
  headerKeys: (CanonicalHeader | null)[],
): { values: Record<string, string>; parseError?: { code: string; message: string } } {
  const values: Record<string, string> = {};
  let parseError: { code: string; message: string } | undefined;
  for (let col = 1; col < cells.length; col++) {
    const k = headerKeys[col - 1];
    if (!k) continue;
    try {
      const norm = cellToString(cells[col]);
      if (norm !== null) values[k] = norm;
    } catch (err) {
      const code = (err as { code?: string }).code ?? "INVALID_CELL";
      parseError = { code, message: (err as Error).message };
    }
  }
  return { values, parseError };
}

async function parseXlsxBuffer(buffer: Buffer): Promise<ParsedRow[]> {
  const workbook = new ExcelJS.Workbook();
  // ExcelJS narrows to a plain Buffer; cast through ArrayBuffer to keep
  // tsc strict happy under Node 20+'s `Buffer<ArrayBufferLike>`.
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet || sheet.rowCount === 0) return [];
  const headerVals = Array.isArray(sheet.getRow(1).values)
    ? (sheet.getRow(1).values as unknown[])
    : [];
  const headerKeys = extractHeaderKeysXlsx(headerVals);
  const rows: ParsedRow[] = [];
  const cap = Math.min(sheet.rowCount, MAX_ROWS + 1);
  for (let r = 2; r <= cap; r++) {
    const row = sheet.getRow(r);
    if (!row.hasValues) continue;
    const cells = Array.isArray(row.values) ? (row.values as unknown[]) : [];
    const parsed = extractXlsxRow(cells, headerKeys);
    rows.push({ rowNumber: r - 1, values: parsed.values, parseError: parsed.parseError });
  }
  return rows;
}

function isCsv(mimeType: string, fileName: string): boolean {
  const lower = mimeType.toLowerCase();
  if (lower === "text/csv" || lower === "application/csv" || lower === "text/plain") return true;
  return /\.csv$/i.test(fileName);
}

async function parseFile(buffer: Buffer, mimeType: string, fileName: string): Promise<ParsedRow[]> {
  if (isCsv(mimeType, fileName)) return parseCsvBuffer(buffer);
  return parseXlsxBuffer(buffer);
}

// ─── Validation (lockstep with API validation.ts) ──────────────────────────

const CONSTITUENT_TYPES = ["donor", "volunteer", "member", "beneficiary", "partner"] as const;
type ConstituentTypeLiteral = (typeof CONSTITUENT_TYPES)[number];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COUNTRY_CODE_RE = /^[A-Z]{2}$/;

interface ValidationError {
  field: string;
  code: string;
  message: string;
}

interface ConstituentPayload {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  addressLine1?: string;
  addressLine2?: string;
  postalCode?: string;
  city?: string;
  countryCode?: string;
  // Issue #465 — multi-valued. Truncated to a single value before insert
  // when the `constituents.multi_type` flag is off for the tenant.
  types?: ConstituentTypeLiteral[];
  tags?: string[];
}

function validateCountryWorker(
  raw: string | undefined,
  errors: ValidationError[],
): string | undefined {
  if (!raw) return undefined;
  if (!COUNTRY_CODE_RE.test(raw)) {
    errors.push({
      field: "countryCode",
      code: "INVALID_COUNTRY_CODE",
      message: "countryCode must be a 2-letter ISO 3166-1 code",
    });
    return undefined;
  }
  return raw;
}

/**
 * Parse a `type` cell into a deduped array of valid types (issue #465). The
 * cell may carry several values separated by `;`, `,`, or `|`. Mirrors the
 * API-side `validateTypes` in `bulk-import/validation.ts`.
 */
function validateTypeWorker(
  raw: string | undefined,
  errors: ValidationError[],
): ConstituentTypeLiteral[] | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(/[;,|]/)
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return undefined;
  const invalid = parts.find((p) => !CONSTITUENT_TYPES.includes(p as ConstituentTypeLiteral));
  if (invalid) {
    errors.push({
      field: "type",
      code: "INVALID_TYPE",
      message: `type must be one of ${CONSTITUENT_TYPES.join(", ")}`,
    });
    return undefined;
  }
  return Array.from(new Set(parts)) as ConstituentTypeLiteral[];
}

function parseTagsWorker(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const split = raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && t.length <= 64);
  return split.length > 0 ? Array.from(new Set(split)) : undefined;
}

function checkLengthsWorker(
  values: Record<string, string | undefined>,
  errors: ValidationError[],
): void {
  const limits: Array<[string, number]> = [
    ["firstName", 255],
    ["lastName", 255],
    ["email", 255],
    ["phone", 50],
    ["addressLine1", 255],
    ["addressLine2", 255],
    ["postalCode", 20],
    ["city", 255],
  ];
  for (const [field, max] of limits) {
    const v = values[field];
    if (v && v.length > max) {
      errors.push({
        field,
        code: "FIELD_TOO_LONG",
        message: `${field} exceeds the ${max}-character limit`,
      });
    }
  }
}

function validate(
  values: Record<string, string>,
): { ok: true; payload: ConstituentPayload } | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  const firstName = values.firstName?.trim();
  const lastName = values.lastName?.trim();
  if (!firstName) {
    errors.push({
      field: "firstName",
      code: "REQUIRED_FIRST_NAME",
      message: "firstName is required",
    });
  }
  if (!lastName) {
    errors.push({ field: "lastName", code: "REQUIRED_LAST_NAME", message: "lastName is required" });
  }
  const email = values.email?.trim();
  if (email && !EMAIL_RE.test(email)) {
    errors.push({ field: "email", code: "INVALID_EMAIL", message: "Email format is invalid" });
  }
  const phone = values.phone?.trim();
  const addressLine1 = values.addressLine1?.trim();
  const addressLine2 = values.addressLine2?.trim();
  const postalCode = values.postalCode?.trim();
  const city = values.city?.trim();
  checkLengthsWorker(
    { firstName, lastName, email, phone, addressLine1, addressLine2, postalCode, city },
    errors,
  );
  const countryCode = validateCountryWorker(values.countryCode?.trim().toUpperCase(), errors);
  const types = validateTypeWorker(values.type, errors);
  const tags = parseTagsWorker(values.tags?.trim());

  if (errors.length > 0) return { ok: false, errors };

  // biome-ignore lint/style/noNonNullAssertion: required above
  const payload: ConstituentPayload = { firstName: firstName!, lastName: lastName! };
  if (email) payload.email = email;
  if (phone) payload.phone = phone;
  if (addressLine1) payload.addressLine1 = addressLine1;
  if (addressLine2) payload.addressLine2 = addressLine2;
  if (postalCode) payload.postalCode = postalCode;
  if (city) payload.city = city;
  if (countryCode) payload.countryCode = countryCode;
  if (types) payload.types = types;
  if (tags) payload.tags = tags;
  return { ok: true, payload };
}

function hasCompleteAddress(p: ConstituentPayload): boolean {
  return Boolean(p.addressLine1 && p.postalCode && p.city && p.countryCode);
}

// ─── Duplicate detection (mirrors `findDuplicates` in API service.ts) ───────

interface DuplicateMatch {
  id: string;
  score: number;
}

async function findDuplicate(
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle tx type is internal
  tx: any,
  orgId: string,
  payload: ConstituentPayload,
): Promise<DuplicateMatch | null> {
  const rows = await tx.execute(sql`
    SELECT id,
      (
        similarity(first_name, ${payload.firstName}) * 0.35
        + similarity(last_name, ${payload.lastName}) * 0.35
        + CASE WHEN ${payload.email ?? null}::text IS NOT NULL
                    AND email IS NOT NULL
                    AND lower(email) = lower(${payload.email ?? null}::text)
               THEN 0.30 ELSE 0.0 END
      ) AS score
    FROM constituents
    WHERE org_id = ${orgId}
      AND deleted_at IS NULL
      AND (
        similarity(first_name, ${payload.firstName}) > 0.3
        OR similarity(last_name, ${payload.lastName}) > 0.3
        OR (
          ${payload.email ?? null}::text IS NOT NULL
          AND email IS NOT NULL
          AND lower(email) = lower(${payload.email ?? null}::text)
        )
      )
    ORDER BY score DESC, created_at DESC
    LIMIT 1
  `);
  const r = (rows.rows as Array<{ id: string; score: string | number }> | undefined)?.[0];
  if (!r) return null;
  const score = typeof r.score === "string" ? Number(r.score) : r.score;
  if (score < 0.3) return null;
  return { id: r.id, score };
}

// ─── Processor ─────────────────────────────────────────────────────────────

interface JobAccumulator {
  processed: number;
  created: number;
  duplicate: number;
  failed: number;
  emailWithValue: number;
  completeAddress: number;
}

async function flushBatchCounters(
  orgId: string,
  jobId: string,
  delta: JobAccumulator,
): Promise<void> {
  if (delta.processed === 0) return;
  await withWorkerContext(orgId, async (tx) => {
    await tx
      .update(bulkImportJobs)
      .set({
        processedRows: sql`${bulkImportJobs.processedRows} + ${delta.processed}`,
        createdCount: sql`${bulkImportJobs.createdCount} + ${delta.created}`,
        duplicateCount: sql`${bulkImportJobs.duplicateCount} + ${delta.duplicate}`,
        failedCount: sql`${bulkImportJobs.failedCount} + ${delta.failed}`,
        emailCount: sql`${bulkImportJobs.emailCount} + ${delta.emailWithValue}`,
        completeAddressCount: sql`${bulkImportJobs.completeAddressCount} + ${delta.completeAddress}`,
        updatedAt: new Date(),
      })
      .where(and(eq(bulkImportJobs.id, jobId), eq(bulkImportJobs.orgId, orgId)));
  });
}

interface RowContext {
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle tx type is internal
  tx: any;
  row: ParsedRow;
  orgId: string;
  jobId: string;
  batchDelta: JobAccumulator;
  log: ReturnType<typeof jobLogger>;
  // Issue #465 — when off, multi-valued `types` cells are truncated to a
  // single value on insert so the off-state matches the legacy picklist.
  multiTypeEnabled: boolean;
}

async function recordFailedRow(
  ctx: RowContext,
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  ctx.batchDelta.failed += 1;
  await ctx.tx.insert(bulkImportResults).values({
    orgId: ctx.orgId,
    jobId: ctx.jobId,
    rowNumber: ctx.row.rowNumber,
    rowData: ctx.row.values,
    status: "failed",
    errorCode,
    errorMessage,
  });
}

async function insertCreatedRow(ctx: RowContext, payload: ConstituentPayload): Promise<void> {
  try {
    // Issue #465 — keep the legacy singular `type` column in lockstep with
    // `types[0]` (back-compat shadow), and enforce the multi-type gate: with
    // the flag off, only the first type is kept. Omitted `types` leaves the
    // DB defaults (`{donor}` / `donor`) to apply.
    const { types: rawTypes, ...rest } = payload;
    const types = ctx.multiTypeEnabled ? rawTypes : rawTypes?.slice(0, 1);
    const typeColumns = types && types.length > 0 ? { types, type: types[0] } : {};
    const [inserted] = await ctx.tx
      .insert(constituents)
      .values({ ...rest, ...typeColumns, orgId: ctx.orgId })
      .returning({ id: constituents.id });
    if (!inserted) throw new Error("Constituent insert returned no row");
    ctx.batchDelta.created += 1;
    if (payload.email) ctx.batchDelta.emailWithValue += 1;
    if (hasCompleteAddress(payload)) ctx.batchDelta.completeAddress += 1;
    await ctx.tx.insert(bulkImportResults).values({
      orgId: ctx.orgId,
      jobId: ctx.jobId,
      rowNumber: ctx.row.rowNumber,
      rowData: ctx.row.values,
      status: "created",
      constituentId: inserted.id,
    });
  } catch (err) {
    ctx.log.warn(
      { err: err instanceof Error ? err.message : String(err), rowNumber: ctx.row.rowNumber },
      "Bulk import: per-row insert failed",
    );
    // Never leak the raw DB error string into the operator-visible
    // result row.
    await recordFailedRow(ctx, "INSERT_FAILED", "Failed to insert constituent");
  }
}

async function processOneRow(ctx: RowContext): Promise<void> {
  // 1. Parse-time error (INVALID_CELL on a formula in XLSX).
  if (ctx.row.parseError) {
    await recordFailedRow(ctx, ctx.row.parseError.code, ctx.row.parseError.message);
    return;
  }

  // 2. Validation.
  const v = validate(ctx.row.values);
  if (!v.ok) {
    const first = v.errors[0];
    await recordFailedRow(
      ctx,
      first?.code ?? "VALIDATION_FAILED",
      v.errors.map((e) => e.message).join("; "),
    );
    return;
  }

  // 3. Duplicate detection — same trigram + email-match scorer as the API.
  const dup = await findDuplicate(ctx.tx, ctx.orgId, v.payload);
  if (dup) {
    ctx.batchDelta.duplicate += 1;
    await ctx.tx.insert(bulkImportResults).values({
      orgId: ctx.orgId,
      jobId: ctx.jobId,
      rowNumber: ctx.row.rowNumber,
      rowData: ctx.row.values,
      status: "duplicate",
      duplicateOfId: dup.id,
      duplicateScore: dup.score.toFixed(2),
    });
    return;
  }

  // 4. Create.
  await insertCreatedRow(ctx, v.payload);
}

export async function processBulkImport(
  job: Job<ProcessBulkImportJob["data"]>,
): Promise<{ created: number; duplicate: number; failed: number; totalRows: number }> {
  const data = job.data;
  const log = jobLogger({ tenantId: data.orgId, jobId: job.id });

  // Defence-in-depth flag gate. The API route already checks the flag
  // (`requireFlag` 404s a disabled feature), but a flipped-off flag
  // can race a relay tick that already enqueued the job — the worker
  // is the second wall.
  const enabled = await isFlagEnabled(FEATURE_FLAG_KEYS.CONSTITUENTS_BULK_IMPORT);
  if (!enabled) {
    log.warn(
      { orgId: data.orgId, bulkImportJobId: data.bulkImportJobId },
      "Bulk import feature flag is off — dropping job",
    );
    return { created: 0, duplicate: 0, failed: 0, totalRows: 0 };
  }

  // Issue #465 — tenant-aware multi-type gate, read once per job. When off,
  // `insertCreatedRow` truncates multi-valued `types` cells to a single value.
  const multiTypeEnabled = await isFlagEnabledForTenant(
    FEATURE_FLAG_KEYS.CONSTITUENTS_MULTI_TYPE,
    data.orgId,
  );

  // 1. Load + flip to processing (idempotent).
  const meta = await withWorkerContext(data.orgId, async (tx) => {
    const [row] = await tx
      .select({
        id: bulkImportJobs.id,
        status: bulkImportJobs.status,
        fileId: bulkImportJobs.fileId,
        totalRows: bulkImportJobs.totalRows,
        requestedBy: bulkImportJobs.requestedBy,
      })
      .from(bulkImportJobs)
      .where(
        and(
          eq(bulkImportJobs.id, data.bulkImportJobId),
          eq(bulkImportJobs.orgId, data.orgId),
          isNull(bulkImportJobs.deletedAt),
        ),
      );
    if (!row) return null;
    if (row.status === "completed" || row.status === "partial" || row.status === "failed") {
      return { ...row, alreadyTerminal: true as const };
    }

    const [file] = await tx
      .select({
        s3Key: bulkImportFiles.s3Key,
        s3Bucket: bulkImportFiles.s3Bucket,
        fileName: bulkImportFiles.fileName,
        mimeType: bulkImportFiles.mimeType,
      })
      .from(bulkImportFiles)
      // Defence in depth (issue #430): scope by orgId even on PK lookup
      // so a drifted `fileId` pointer cannot fetch a foreign tenant's
      // S3 upload metadata (which would trigger an S3 download for the
      // wrong tenant).
      .where(and(eq(bulkImportFiles.id, row.fileId), eq(bulkImportFiles.orgId, data.orgId)));
    if (!file) return null;

    await tx
      .update(bulkImportJobs)
      .set({ status: "processing", updatedAt: new Date() })
      .where(and(eq(bulkImportJobs.id, row.id), eq(bulkImportJobs.orgId, data.orgId)));

    return { ...row, alreadyTerminal: false as const, file };
  });

  if (!meta) {
    log.warn({ bulkImportJobId: data.bulkImportJobId }, "Bulk import job row not found");
    return { created: 0, duplicate: 0, failed: 0, totalRows: 0 };
  }
  if (meta.alreadyTerminal) {
    log.info({ status: meta.status }, "Bulk import job already terminal — skipping retry");
    return { created: 0, duplicate: 0, failed: 0, totalRows: 0 };
  }

  // 2. Download + parse the file.
  let parsedRows: ParsedRow[];
  try {
    const buffer = await downloadFile(meta.file.s3Bucket, meta.file.s3Key);
    parsedRows = await parseFile(buffer, meta.file.mimeType, meta.file.fileName);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Bulk import: file download / parse failed",
    );
    await finaliseFailed(data.orgId, data.bulkImportJobId, "Failed to read uploaded file");
    return { created: 0, duplicate: 0, failed: 0, totalRows: 0 };
  }

  // 3. Process in batches of 50.
  const acc: JobAccumulator = {
    processed: 0,
    created: 0,
    duplicate: 0,
    failed: 0,
    emailWithValue: 0,
    completeAddress: 0,
  };

  for (let i = 0; i < parsedRows.length; i += BATCH_SIZE) {
    const batch = parsedRows.slice(i, i + BATCH_SIZE);
    const batchDelta: JobAccumulator = {
      processed: 0,
      created: 0,
      duplicate: 0,
      failed: 0,
      emailWithValue: 0,
      completeAddress: 0,
    };

    await withWorkerContext(data.orgId, async (tx) => {
      for (const row of batch) {
        batchDelta.processed += 1;
        await processOneRow({
          tx,
          row,
          orgId: data.orgId,
          jobId: data.bulkImportJobId,
          batchDelta,
          log,
          multiTypeEnabled,
        });
      }
    });

    await flushBatchCounters(data.orgId, data.bulkImportJobId, batchDelta);
    acc.processed += batchDelta.processed;
    acc.created += batchDelta.created;
    acc.duplicate += batchDelta.duplicate;
    acc.failed += batchDelta.failed;
    acc.emailWithValue += batchDelta.emailWithValue;
    acc.completeAddress += batchDelta.completeAddress;
  }

  // 4. Finalise + audit log.
  const status: "completed" | "partial" =
    acc.failed === 0 && acc.duplicate === 0 ? "completed" : "partial";

  await withWorkerContext(data.orgId, async (tx) => {
    await tx
      .update(bulkImportJobs)
      .set({ status, completedAt: new Date(), updatedAt: new Date() })
      .where(
        and(eq(bulkImportJobs.id, data.bulkImportJobId), eq(bulkImportJobs.orgId, data.orgId)),
      );

    await tx.insert(auditLogs).values({
      orgId: data.orgId,
      // No request-scoped userId in the worker context — the original
      // requester is captured on bulk_import_jobs.requested_by.
      userId: meta.requestedBy ?? null,
      action: "constituents.bulk_import.completed",
      resourceType: "bulk_import_jobs",
      resourceId: data.bulkImportJobId,
      newValues: {
        status,
        totalRows: acc.processed,
        created: acc.created,
        duplicate: acc.duplicate,
        failed: acc.failed,
      },
    });
  });

  log.info(
    {
      bulkImportJobId: data.bulkImportJobId,
      status,
      created: acc.created,
      duplicate: acc.duplicate,
      failed: acc.failed,
      total: acc.processed,
      event: status === "partial" ? "bulk_import.partial" : "bulk_import.completed",
    },
    "Bulk import job finalised",
  );

  return {
    created: acc.created,
    duplicate: acc.duplicate,
    failed: acc.failed,
    totalRows: acc.processed,
  };
}

async function finaliseFailed(orgId: string, jobId: string, message: string): Promise<void> {
  await withWorkerContext(orgId, async (tx) => {
    await tx
      .update(bulkImportJobs)
      .set({
        status: "failed",
        // Never leak the raw error — the public-facing column gets a
        // generic message; details land in the structured pino log.
        error: message,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(bulkImportJobs.id, jobId), eq(bulkImportJobs.orgId, orgId)));
  });
}
