/**
 * Job processor — re-wrap receipt DEKs under the active KEK version
 * (issue #228, KEK rotation).
 *
 * Runbook-triggered (no cron): after the operator adds a new KEK
 * version and flips the active one, this sweep walks every encrypted
 * `receipts` row still wrapped under an older version, unwraps the DEK
 * with the OLD KEK version (still resolvable by the provider) and
 * re-wraps it with the ACTIVE one. Zero S3 access — the object's
 * ciphertext is keyed by the per-receipt DEK, which never changes;
 * only the DB-side wrapped copy of that DEK is refreshed. That
 * DB-only property is the entire point of the envelope design.
 *
 * Failure posture: per-row isolation (one un-unwrappable row — e.g. a
 * version the keyring no longer holds — logs and continues), summary
 * `{ scanned, rewrapped, failed }` at the end. Failed rows keep their
 * old kek_version_id and will be retried by the next sweep once the
 * keyring is fixed.
 */

import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import type { RewrapReceiptDeksJob } from "@givernance/shared/jobs";
import type { KekProvider } from "@givernance/shared/lib/receipt-crypto";
import { receipts } from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { and, eq, isNotNull, ne, notInArray } from "drizzle-orm";
import { db } from "../lib/db.js";
import { isFlagEnabled } from "../lib/flags.js";
import { jobLogger } from "../lib/logger.js";
import { getReceiptKekProvider } from "../lib/receipt-kek.js";
import { extractTraceId } from "../lib/trace-context.js";

const BATCH_SIZE = 100;

interface SweepRow {
  id: string;
  orgId: string;
  dekWrapped: string | null;
  kekVersionId: string | null;
}

/**
 * Re-wrap a single row: unwrap under its recorded KEK version, wrap
 * under the active one, persist. Throws on any failure — the caller
 * isolates the error per row.
 */
async function rewrapRow(kekProvider: KekProvider, row: SweepRow): Promise<void> {
  if (!row.dekWrapped || !row.kekVersionId) {
    // CHECK constraint makes this unreachable; belt-and-suspenders.
    throw new Error("encrypted receipt row is missing dek_wrapped/kek_version_id");
  }
  const dek = await kekProvider.unwrap(row.dekWrapped, row.kekVersionId);
  const { wrapped, kekVersionId } = await kekProvider.wrap(dek);
  await db
    .update(receipts)
    .set({ dekWrapped: wrapped, kekVersionId, updatedAt: new Date() })
    .where(and(eq(receipts.id, row.id), eq(receipts.orgId, row.orgId)));
}

/** Sweep every encrypted receipt row onto the active KEK version. */
export async function processRewrapReceiptDeks(
  job: Job<RewrapReceiptDeksJob["data"] & { traceparent?: string }>,
) {
  const { requestedBy, traceparent } = job.data ?? {};
  const log = jobLogger({
    tenantId: "platform",
    jobId: job.id,
    traceId: extractTraceId(traceparent),
  });

  // Defence-in-depth gate at pickup (feature-flag-first rule): if the
  // envelope feature is off, the sweep is a loud no-op — an operator
  // who enqueued it by mistake sees WHY nothing happened.
  const enabled = await isFlagEnabled(FEATURE_FLAG_KEYS.DONATION_RECEIPT_ENVELOPE_ENCRYPTION);
  if (!enabled) {
    log.info(
      { requestedBy },
      "Receipt DEK re-wrap skipped — donation.receipt_envelope_encryption flag is off",
    );
    job.log("Skipped: donation.receipt_envelope_encryption flag is off");
    return { skipped: true, scanned: 0, rewrapped: 0, failed: 0 };
  }

  // Throws on misconfiguration — the job fails loudly rather than
  // sweeping with the wrong key material.
  const kekProvider = getReceiptKekProvider();
  const activeVersion = kekProvider.activeVersionId();

  log.info({ requestedBy, activeVersion }, "Receipt DEK re-wrap sweep starting");

  let scanned = 0;
  let rewrapped = 0;
  let failed = 0;
  // Rows whose unwrap/re-wrap failed still match the sweep predicate;
  // excluding them from subsequent batches guarantees forward progress
  // (bounded memory: ids of failed rows only).
  const failedIds: string[] = [];

  for (;;) {
    // CROSS-TENANT INTENTIONAL: platform-wide KEK rotation sweep. The
    // worker's owner pool (`db`) is used deliberately — rotation spans
    // every tenant's receipts by design (the KEK is a platform secret,
    // not tenant data). Each UPDATE below still carries the precise
    // `eq(receipts.id, …)` + `eq(receipts.orgId, …)` predicate.
    const rows = await db
      .select({
        id: receipts.id,
        orgId: receipts.orgId,
        dekWrapped: receipts.dekWrapped,
        kekVersionId: receipts.kekVersionId,
      })
      .from(receipts)
      .where(
        and(
          isNotNull(receipts.encryptionScheme),
          isNotNull(receipts.kekVersionId),
          ne(receipts.kekVersionId, activeVersion),
          ...(failedIds.length > 0 ? [notInArray(receipts.id, failedIds)] : []),
        ),
      )
      .limit(BATCH_SIZE);

    if (rows.length === 0) break;

    for (const row of rows) {
      scanned += 1;
      try {
        await rewrapRow(kekProvider, row);
        rewrapped += 1;
      } catch (err) {
        failed += 1;
        failedIds.push(row.id);
        // No key material in the log line (pino redacts dekWrapped
        // anyway) — receiptId + old version + reason is what the
        // runbook needs.
        log.error(
          {
            receiptId: row.id,
            kekVersionId: row.kekVersionId,
            reason: err instanceof Error ? err.message : String(err),
          },
          "Receipt DEK re-wrap failed for row — continuing sweep",
        );
      }
    }

    if (rows.length < BATCH_SIZE) break;
  }

  log.info({ scanned, rewrapped, failed, activeVersion }, "Receipt DEK re-wrap sweep finished");
  job.log(`Re-wrap sweep done: scanned=${scanned} rewrapped=${rewrapped} failed=${failed}`);
  return { skipped: false, scanned, rewrapped, failed };
}
