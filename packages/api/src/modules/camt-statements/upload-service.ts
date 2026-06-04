/**
 * camt.053 upload service (Epic #318 PR #5, docs/25 §1 step F).
 *
 * The HTTP handler streams a multipart `.xml` upload into a Buffer; this
 * service validates the bank account is live, generates the S3 key,
 * pushes the bytes into the private `bank-statements` bucket, inserts
 * the `camt_statements` row (`status='pending'`), and emits the
 * `camt053.uploaded` outbox event the worker picks up.
 *
 * The whole thing runs in a single Postgres transaction so the outbox
 * row is atomic with the statement insert — a S3 PUT happens BEFORE
 * the DB write because we need a stable key in the row, but the worker
 * tolerates a missing-object on retry (statement row stays `pending`
 * and the operator can re-upload).
 */

import { auditLogs, bankAccounts, camtStatements, outboxEvents } from "@givernance/shared/schema";
import { and, eq, isNull } from "drizzle-orm";
import { withTenantContext } from "../../lib/db.js";
import { bankStatementKey, putBankStatement } from "../../lib/s3.js";

export class CamtUploadValidationError extends Error {
  public readonly code:
    | "bank_account_not_found"
    | "file_too_large"
    | "unsupported_content_type"
    | "filename_not_xml"
    | "empty_file";
  constructor(
    code:
      | "bank_account_not_found"
      | "file_too_large"
      | "unsupported_content_type"
      | "filename_not_xml"
      | "empty_file",
    message: string,
  ) {
    super(message);
    this.name = "CamtUploadValidationError";
    this.code = code;
  }
}

export interface CamtUploadInput {
  orgId: string;
  bankAccountId: string;
  filename: string;
  contentType: string;
  body: Buffer;
  /**
   * Resolved `users.id` row UUID of the authenticated tenant user
   * (`request.auth.userRowId`). This is what lands in the
   * `camt_statements.uploaded_by` FK. Distinct from `uploadedByUserId`
   * below — Epic #363 deliberately split `users.id` from the Keycloak
   * `sub`, so the JWT subject is NOT a valid `users.id` and writing it
   * here trips the FK. `null` for actors with no tenant `users` row
   * (e.g. super-admins).
   */
  uploadedByRowId: string | null;
  /**
   * JWT `sub` (Keycloak id) of the subject — recorded on the `audit_logs`
   * row's varchar `user_id`, NOT a `users.id` FK. Keep distinct from
   * `uploadedByRowId`.
   */
  uploadedByUserId: string | null;
  /** RFC 8693 `act.sub` (impersonator Keycloak id) for the audit row. */
  effectiveActorId?: string | null;
}

export interface CamtUploadResult {
  statementId: string;
  status: "pending";
  s3Path: string;
}

/** ≤50 MB per docs/25 §6 / ADR-028. */
export const CAMT_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

const ACCEPTED_CONTENT_TYPES = new Set([
  "application/xml",
  "text/xml",
  // Some browsers send octet-stream for `.xml`; accept it but the
  // filename + structural parse downstream catches non-XML bodies.
  "application/octet-stream",
]);

function sanitiseFilename(input: string): string {
  // Strip path separators, keep alnum + dash + dot + underscore. Cap
  // at 120 chars (the bucket key has plenty of headroom but we keep
  // the operator's familiar filename short enough to fit in download
  // dialogs).
  const segments = input.split(/[\\/]/);
  const lastSegment = segments[segments.length - 1] ?? input;
  const cleaned = lastSegment.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
  return cleaned || "statement.xml";
}

export async function uploadCamtStatement(input: CamtUploadInput): Promise<CamtUploadResult> {
  // ── Defensive validations. ──────────────────────────────────────
  if (input.body.length === 0) {
    throw new CamtUploadValidationError("empty_file", "Uploaded file is empty.");
  }
  if (input.body.length > CAMT_UPLOAD_MAX_BYTES) {
    throw new CamtUploadValidationError(
      "file_too_large",
      `File exceeds ${Math.floor(CAMT_UPLOAD_MAX_BYTES / 1024 / 1024)} MB cap.`,
    );
  }
  if (!ACCEPTED_CONTENT_TYPES.has(input.contentType)) {
    throw new CamtUploadValidationError(
      "unsupported_content_type",
      `Content-Type must be application/xml or text/xml (got ${input.contentType}).`,
    );
  }
  if (!input.filename.toLowerCase().endsWith(".xml")) {
    throw new CamtUploadValidationError("filename_not_xml", "Filename must end with `.xml`.");
  }

  // ── Bank-account ownership check. ───────────────────────────────
  const accountCheck = await withTenantContext(input.orgId, async (tx) => {
    const [row] = await tx
      .select({ id: bankAccounts.id })
      .from(bankAccounts)
      .where(
        and(
          eq(bankAccounts.id, input.bankAccountId),
          eq(bankAccounts.orgId, input.orgId),
          isNull(bankAccounts.deletedAt),
        ),
      );
    return row;
  });
  if (!accountCheck) {
    throw new CamtUploadValidationError(
      "bank_account_not_found",
      `Bank account ${input.bankAccountId} not found for this org.`,
    );
  }

  // ── S3 PUT. ─────────────────────────────────────────────────────
  const now = new Date();
  const sanitised = sanitiseFilename(input.filename);
  // Prefix the sanitised filename with a millisecond timestamp so two
  // uploads on the same day with the same filename don't overwrite
  // each other — preserves the 10-yr audit chain.
  const stampedFilename = `${now.getTime()}_${sanitised}`;
  const key = bankStatementKey({
    orgId: input.orgId,
    year: now.getUTCFullYear(),
    month: now.getUTCMonth() + 1,
    filename: stampedFilename,
  });
  await putBankStatement({
    key,
    body: input.body,
    contentType: "application/xml",
  });

  // ── DB write — atomic with the outbox event + audit row. ────────
  const statementId = await withTenantContext(input.orgId, async (tx) => {
    const [inserted] = await tx
      .insert(camtStatements)
      .values({
        orgId: input.orgId,
        bankAccountId: input.bankAccountId,
        s3Path: key,
        // msgId is filled by the worker after parse — we set a
        // placeholder unique-per-row value here so the unique index
        // on (org_id, msg_id) doesn't collide on concurrent pending
        // uploads. The placeholder uses the statement id (we haven't
        // generated it yet — so we use a UUID we control). Since
        // the column has a CHECK length <= 35 we encode the orgId
        // suffix + millis to stay under the cap.
        msgId: `__pending_${now.getTime()}_${Math.random().toString(36).slice(2, 10)}`,
        status: "pending",
        // FK → users.id. Must be the resolved row id (Epic #363 split
        // users.id from the JWT sub); the audit row below keeps the sub
        // + act.sub for double-attribution.
        uploadedBy: input.uploadedByRowId,
      })
      .returning({ id: camtStatements.id });
    if (!inserted) throw new Error("camt_statements insert returned no row");

    await tx.insert(outboxEvents).values({
      tenantId: input.orgId,
      type: "camt053.uploaded",
      payload: {
        statementId: inserted.id,
        bankAccountId: input.bankAccountId,
        orgId: input.orgId,
      },
    });

    // Audit row (docs/25 §7.bis). The `audit` plugin writes its own
    // row on every mutating request — but the rich `new_values` JSON
    // for camt uploads is most useful here in the service because we
    // have the bank-account context (avoids a second SELECT from the
    // plugin). The plugin's row still lands too, with the request-
    // shape metadata; this row carries the domain shape.
    await tx.insert(auditLogs).values({
      orgId: input.orgId,
      userId: input.uploadedByUserId ?? "",
      actorId: input.effectiveActorId ?? null,
      action: "DOMAIN:camt_statement.upload",
      resourceType: "camt_statement",
      resourceId: inserted.id,
      newValues: {
        msgId: null,
        bankAccountId: input.bankAccountId,
        s3Path: key,
        fileSize: input.body.length,
        originalFilename: sanitised,
      },
    });

    return inserted.id;
  });

  return { statementId, status: "pending", s3Path: key };
}
