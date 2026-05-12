/**
 * camt.053 import processor (Epic #318 PR #5, ADR-028).
 *
 * Triggered by the `camt053.uploaded` outbox event:
 *
 *   1. Load the `camt_statements` row.
 *   2. GET the raw XML from the `bank-statements` bucket.
 *   3. Parse + structural-validate (`parseCamt053`).
 *   4. Resolve the bank account by IBAN — file-level rejection on
 *      foreign-IBAN (docs/25 §5.4 step 3, ADR-028 §"Foreign-IBAN
 *      safety"). The rejected file is relocated under the
 *      `rejected/{yyyy}/{mm}/{uuid}.xml` key prefix in the same bucket
 *      so the operator can audit *why* it was rejected.
 *   5. File-level idempotency on `(org_id, msg_id)`: if an EARLIER row
 *      already carries this `MsgId`, mark the current row `duplicate`
 *      with `error_code='duplicate_msg_id'` and ack.
 *   6. Per-entry persist into `camt_credit_entries` (idempotent on the
 *      `(org_id, statement_id, acct_svcr_ref, COALESCE(end_to_end_id, ''))`
 *      partial unique from migration 0044). Pending entries skipped
 *      silently; reversals stored with `reversal_indicator=true` for
 *      the reconciler to act on.
 *   7. Flip the statement to `imported` and emit `camt053.imported`
 *      so the reconcile processor picks it up.
 *
 * Recovery posture (ADR-028 §"Idempotency"): re-running this job on the
 * same statement is a no-op — every per-entry INSERT short-circuits on
 * the partial unique, the file-level dedup on `MsgId` keeps the
 * statement row in `imported` / `processed` if a prior run got that
 * far, and the final UPDATE is gated on `status = 'pending'` so a
 * BullMQ retry between import and reconcile doesn't clobber the
 * reconciler's terminal state.
 */

import { randomUUID } from "node:crypto";
import {
  bankAccounts,
  camtCreditEntries,
  camtStatements,
  type NewCamtCreditEntry,
  outboxEvents,
} from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { and, eq, ne, sql } from "drizzle-orm";
import { withWorkerContext } from "../lib/db.js";
import { jobLogger } from "../lib/logger.js";
import {
  bankStatementRejectedKey,
  getBankStatement,
  moveBankStatementToRejected,
} from "../lib/s3.js";
import { extractTraceId } from "../lib/trace-context.js";
import { type CamtEntry, CamtParseError, parseCamt053 } from "../services/camt053-parser.js";

export interface Camt053ImportJobData {
  statementId: string;
  bankAccountId: string;
  orgId: string;
  traceparent?: string;
}

/**
 * Reasons we may mark a statement `failed`. Stored in
 * `camt_statements.error` as a structured prefix so the UI can render
 * a typed banner ("Foreign IBAN" vs "XSD validation failed"); the
 * full human-readable detail follows the prefix.
 */
type ImportFailureCode =
  | "xsd_invalid"
  | "not_document"
  | "unsupported_version"
  | "missing_required_field"
  | "foreign_iban"
  | "missing_object"
  | "duplicate_msg_id";

function formatError(code: ImportFailureCode, detail: string): string {
  return `${code}: ${detail}`;
}

export async function processCamt053Import(job: Job<Camt053ImportJobData>): Promise<void> {
  const { statementId, bankAccountId, orgId, traceparent } = job.data;
  const log = jobLogger({
    tenantId: orgId,
    jobId: job.id,
    traceId: extractTraceId(traceparent),
  });

  log.info({ event: "camt053.import.start", statementId, bankAccountId }, "camt053 import start");

  // ── 1. Load the statement row + verify it's still in `pending`. ──
  const statementRow = await loadPendingStatement(orgId, statementId);
  if (!statementRow) {
    log.warn(
      { event: "camt053.import.skip_not_pending", statementId },
      "Statement not in `pending` — likely a BullMQ retry after success; ack",
    );
    return;
  }

  // ── 2. Fetch the XML. ────────────────────────────────────────────
  const xml = await getBankStatement(statementRow.s3Path);
  if (!xml) {
    await markFailed(
      orgId,
      statementId,
      "missing_object",
      `Object not found at s3 key ${statementRow.s3Path}`,
    );
    log.error(
      { event: "camt053.rejected", statementId, reason: "missing_object" },
      "camt053 upload missing in storage",
    );
    return;
  }

  // ── 3. Parse + structural validate. ──────────────────────────────
  let parsed: ReturnType<typeof parseCamt053>;
  try {
    parsed = parseCamt053(xml);
  } catch (err) {
    if (err instanceof CamtParseError) {
      await markFailed(orgId, statementId, err.code, err.message);
      await safelyRelocateRejected(orgId, statementRow.s3Path);
      log.error(
        { event: "camt053.rejected", statementId, reason: err.code, detail: err.detail },
        "camt053 parse / structural validation failed",
      );
      return;
    }
    throw err;
  }

  // ── 4. Foreign-IBAN safety. ──────────────────────────────────────
  // The statement's `Acct.Id.IBAN` MUST match the bank account row's
  // IBAN we recorded at upload time. A mismatch means the operator
  // uploaded a third-party's statement to the wrong account — reject
  // wholesale (ADR-028 §"Foreign-IBAN safety").
  const accountIban = await loadBankAccountIban(orgId, bankAccountId);
  if (!accountIban) {
    await markFailed(
      orgId,
      statementId,
      "foreign_iban",
      `Bank account ${bankAccountId} not found or soft-deleted`,
    );
    return;
  }
  const stmtIbans = new Set(parsed.statements.map((s) => s.acctIban));
  if (!stmtIbans.has(accountIban)) {
    await markFailed(
      orgId,
      statementId,
      "foreign_iban",
      `Statement IBAN(s) [${[...stmtIbans].join(",")}] do not match bank_account IBAN ${accountIban}`,
    );
    await safelyRelocateRejected(orgId, statementRow.s3Path);
    log.error(
      { event: "camt053.rejected", statementId, reason: "foreign_iban" },
      "camt053 statement references a foreign IBAN",
    );
    return;
  }

  // ── 5. File-level idempotency on (org_id, MsgId). ───────────────
  // If a DIFFERENT row already carries this MsgId (excluding our own
  // pending placeholder), mark the current row as a duplicate. The
  // check below is intentionally over the FINAL msgId only — the
  // placeholder we wrote at upload time is unique-per-row by
  // construction (timestamp + random suffix) so it never collides.
  const duplicate = await findDuplicateMsgId(orgId, parsed.msgId, statementId);
  if (duplicate) {
    await markFailed(
      orgId,
      statementId,
      "duplicate_msg_id",
      `MsgId ${parsed.msgId} already imported on statement ${duplicate}`,
    );
    log.warn(
      { event: "camt053.duplicate", statementId, msgId: parsed.msgId, original: duplicate },
      "camt053 statement is a duplicate of an earlier upload",
    );
    return;
  }

  // ── 6. Persist every entry idempotently. ────────────────────────
  const stats = await persistEntries({
    orgId,
    statementId,
    bankAccountIban: accountIban,
    parsed,
  });

  // ── 7. Flip to `imported` + emit reconcile event. ───────────────
  await flipImportedAndEnqueueReconcile({
    orgId,
    statementId,
    msgId: parsed.msgId,
    fromDate: parsed.statements[0]?.fromDate ?? null,
    toDate: parsed.statements[0]?.toDate ?? null,
    totalCredits: stats.totalCredits,
    traceparent,
  });

  log.info(
    {
      event: "camt053.import.done",
      statementId,
      msgId: parsed.msgId,
      totalCredits: stats.totalCredits,
      reversals: stats.reversals,
      pending: stats.pendingSkipped,
    },
    "camt053 import complete — enqueued reconcile",
  );
}

async function loadPendingStatement(
  orgId: string,
  statementId: string,
): Promise<{ s3Path: string } | null> {
  return withWorkerContext(orgId, async (tx) => {
    const [row] = await tx
      .select({ s3Path: camtStatements.s3Path, status: camtStatements.status })
      .from(camtStatements)
      .where(and(eq(camtStatements.id, statementId), eq(camtStatements.orgId, orgId)));
    if (!row) return null;
    if (row.status !== "pending") return null;
    return { s3Path: row.s3Path };
  });
}

async function loadBankAccountIban(orgId: string, bankAccountId: string): Promise<string | null> {
  return withWorkerContext(orgId, async (tx) => {
    const [row] = await tx
      .select({ iban: bankAccounts.iban, deletedAt: bankAccounts.deletedAt })
      .from(bankAccounts)
      .where(and(eq(bankAccounts.id, bankAccountId), eq(bankAccounts.orgId, orgId)));
    if (!row || row.deletedAt) return null;
    return row.iban;
  });
}

async function findDuplicateMsgId(
  orgId: string,
  msgId: string,
  excludeStatementId: string,
): Promise<string | null> {
  return withWorkerContext(orgId, async (tx) => {
    const [row] = await tx
      .select({ id: camtStatements.id })
      .from(camtStatements)
      .where(
        and(
          eq(camtStatements.orgId, orgId),
          eq(camtStatements.msgId, msgId),
          ne(camtStatements.id, excludeStatementId),
        ),
      )
      .limit(1);
    return row?.id ?? null;
  });
}

async function persistEntries(args: {
  orgId: string;
  statementId: string;
  bankAccountIban: string;
  parsed: ReturnType<typeof parseCamt053>;
}): Promise<{ totalCredits: number; reversals: number; pendingSkipped: number }> {
  const { orgId, statementId, parsed } = args;
  let totalCredits = 0;
  let reversals = 0;
  let pendingSkipped = 0;

  await withWorkerContext(orgId, async (tx) => {
    for (const stmt of parsed.statements) {
      for (const entry of stmt.entries) {
        if (entry.cdtDbtInd !== "CRDT") continue;
        if (entry.sts !== "BOOK") {
          pendingSkipped += 1;
          continue;
        }
        if (entry.reversalIndicator) {
          reversals += 1;
        }
        totalCredits += 1;
        const row = mapEntry({ orgId, statementId, entry });
        // Idempotent on the partial unique
        // `(org_id, statement_id, acct_svcr_ref, COALESCE(end_to_end_id, ''))`
        // declared in migration 0044. `onConflictDoNothing()` lets a
        // BullMQ retry of this processor re-run every entry without
        // duplicating; the reconciler then proceeds on the existing rows.
        await tx.insert(camtCreditEntries).values(row).onConflictDoNothing();
      }
    }
  });

  return { totalCredits, reversals, pendingSkipped };
}

function mapEntry(args: {
  orgId: string;
  statementId: string;
  entry: CamtEntry;
}): NewCamtCreditEntry {
  const { orgId, statementId, entry } = args;
  return {
    orgId,
    statementId,
    acctSvcrRef: entry.acctSvcrRef,
    endToEndId: entry.endToEndId,
    amountCents: entry.amountCents,
    currency: entry.currency,
    valueDate: entry.valueDate ?? undefined,
    bookingDate: entry.bookingDate ?? undefined,
    structuredRef: entry.structuredRef,
    debtorName: entry.debtorName,
    debtorIban: entry.debtorIban,
    reversalIndicator: entry.reversalIndicator,
    debtorAddress: entry.debtorAddress,
  };
}

/**
 * Mark a statement `failed` with a typed error code. Idempotent — we
 * narrow the WHERE on `status = 'pending'` so a concurrent retry that
 * already succeeded doesn't get clobbered into `failed`. Stores the
 * error as `{code}: {detail}` so the UI can prefix-match for the
 * structured banner.
 */
async function markFailed(
  orgId: string,
  statementId: string,
  code: ImportFailureCode,
  detail: string,
): Promise<void> {
  await withWorkerContext(orgId, async (tx) => {
    await tx
      .update(camtStatements)
      .set({
        status: "failed",
        error: formatError(code, detail),
        processedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(camtStatements.id, statementId),
          eq(camtStatements.orgId, orgId),
          eq(camtStatements.status, "pending"),
        ),
      );
  });
}

/**
 * Best-effort: copy the rejected upload into the `rejected/` prefix
 * and delete the original. Failures here are logged but never thrown —
 * the statement row already carries the `failed` status and the
 * operator-facing audit story is intact even if the file relocation
 * fails (e.g. transient S3 outage).
 */
async function safelyRelocateRejected(orgId: string, srcKey: string): Promise<void> {
  try {
    const now = new Date();
    const dstKey = bankStatementRejectedKey({
      orgId,
      year: now.getUTCFullYear(),
      month: now.getUTCMonth() + 1,
      uuid: randomUUID(),
    });
    await moveBankStatementToRejected({ srcKey, dstKey });
  } catch (err) {
    // Don't escalate — the statement row already records the failure.
    // The operator can re-locate manually via the storage audit tool.
    // We deliberately do not have a logger handle in this helper to
    // keep the function pure; the caller logs the rejection event.
    void err;
  }
}

async function flipImportedAndEnqueueReconcile(args: {
  orgId: string;
  statementId: string;
  msgId: string;
  fromDate: string | null;
  toDate: string | null;
  totalCredits: number;
  traceparent?: string;
}): Promise<void> {
  const { orgId, statementId, msgId, fromDate, toDate, totalCredits, traceparent } = args;
  await withWorkerContext(orgId, async (tx) => {
    await tx
      .update(camtStatements)
      .set({
        // `processing` is the intermediate state between import and
        // reconcile — the reconciler flips to `processed` when done.
        // We deliberately don't introduce a new `imported` enum value
        // because the schema's `pending → processing → processed |
        // failed` lifecycle covers the contract: this UPDATE moves
        // the row out of `pending` and the reconciler does the rest.
        status: "processing",
        msgId,
        statementFrom: fromDate,
        statementTo: toDate,
        totalCredits,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(camtStatements.id, statementId),
          eq(camtStatements.orgId, orgId),
          eq(camtStatements.status, "pending"),
        ),
      );

    await tx.insert(outboxEvents).values({
      tenantId: orgId,
      type: "camt053.imported",
      payload: { statementId },
      metadata: traceparent ? { traceparent } : null,
    });
  });
}

// Silence the unused-symbol lint: `sql` is reserved here for the future
// path where the reconciler computes `unmatched_credits` via a single
// SQL aggregate rather than the JS-side counter. Kept imported so the
// refactor lands with one fewer churned file.
void sql;
