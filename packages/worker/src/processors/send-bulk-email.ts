/**
 * Bulk-email processor (Epic #274; partial-send tracking per issue #326).
 *
 * Input: `bulkEmailJobId` referencing a `bulk_email_jobs` row. The
 * processor reads subject, body, and the deliverable constituent_ids
 * snapshot from the row, re-resolves email + name from `constituents`
 * under the worker's RLS context (PII never touches Redis), and walks
 * the recipient list sequentially. Each successful send appends the
 * recipient id to `delivered_constituent_ids` and bumps `delivered_count`
 * in the same UPDATE; each SMTP failure does the same to the `failed_*`
 * column pair.
 *
 * Why incremental per-send updates (vs. a single end-of-job UPDATE):
 *   - The polling UI sees the ratio move in real time — same UX as the
 *     postal-export progress bar.
 *   - On worker process death (Redis wipe, accessory reboot, OOM kill),
 *     the row stays at its last successful update. The operator sees the
 *     partial ratio and can hit "Resume" to re-target the remaining
 *     recipients (issue #326). Without per-send updates, a dropped job
 *     would leave the row at 0/N — indistinguishable from "never started".
 *
 * Soft-deleted constituents (deletedAt IS NOT NULL) are silently dropped
 * at send time so a right-to-erasure between request and send is
 * honoured. They count as neither delivered nor failed: the gap surfaces
 * as `total - delivered - failed > 0` which the operator can resolve by
 * (a) accepting the lower headcount or (b) re-running with a fresh
 * selection.
 */

import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import type { SendBulkEmailJob } from "@givernance/shared/jobs";
import { bulkEmailJobs, constituents } from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { withWorkerContext } from "../lib/db.js";
import { defaultEmailSender, type EmailSender } from "../lib/email.js";
import { isFlagEnabled } from "../lib/flags.js";
import { jobLogger } from "../lib/logger.js";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Wrap the admin-supplied plain-text body in a minimal HTML shell. */
function renderHtml(subject: string, body: string, recipientName: string): string {
  const safeSubject = escapeHtml(subject);
  const greeting = recipientName ? `Hi ${escapeHtml(recipientName)},` : "Hello,";
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${safeSubject}</title>
  </head>
  <body style="font-family: system-ui, -apple-system, sans-serif; line-height: 1.5; color: #1f2937;">
    <div style="max-width: 560px; margin: 0 auto; padding: 24px;">
      <p>${greeting}</p>
      ${paragraphs}
      <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 32px 0;" />
      <p style="font-size: 12px; color: #6b7280;">
        Sent via Givernance.
      </p>
    </div>
  </body>
</html>`;
}

function renderText(body: string, recipientName: string): string {
  const greeting = recipientName ? `Hi ${recipientName},` : "Hello,";
  return `${greeting}\n\n${body}\n\n— Sent via Givernance.`;
}

/**
 * Test-seam: the production code wires `defaultEmailSender` here. Worker
 * integration tests inject a recording sender so they can assert per-
 * recipient send semantics without booting a real SMTP transport.
 */
export interface ProcessSendBulkEmailDeps {
  emailSender?: EmailSender;
  /**
   * Test-seam: production wires `isFlagEnabled` (PG read). Worker
   * integration tests override this to assert the flag-off short-
   * circuit without seeding the registry. Returns `true` when omitted
   * for test setups that don't care about the gate.
   */
  isFlagEnabled?: (key: string) => Promise<boolean>;
}

export async function processSendBulkEmail(
  job: Job<SendBulkEmailJob["data"]>,
  deps: ProcessSendBulkEmailDeps = {},
): Promise<{ sent: number; failed: number; skipped: number }> {
  const data = job.data;
  const log = jobLogger({ tenantId: data.orgId, jobId: job.id });
  const sender = deps.emailSender ?? defaultEmailSender;
  const evaluateFlag = deps.isFlagEnabled ?? isFlagEnabled;

  // Defence-in-depth flag gate. The API route already checks the flag
  // (`requireFlag` 404s a disabled feature), but a flipped-off flag
  // can race a relay tick that already enqueued the job — the worker
  // is the second wall. Dropping silently here is the correct
  // posture: the operator's UI already shows the dispatch toast, and
  // the DB row stays at `pending` until the admin either flips the
  // flag back on (a retry will then resume), explicitly cancels, or
  // the row falls out of the 20-row recent list.
  const featureEnabled = await evaluateFlag(FEATURE_FLAG_KEYS.COMMUNICATION_BULK_EMAIL);
  if (!featureEnabled) {
    log.warn(
      { orgId: data.orgId, bulkEmailJobId: data.bulkEmailJobId },
      "Bulk email feature flag is off — dropping job without sending",
    );
    return { sent: 0, failed: 0, skipped: 0 };
  }

  const bulkEmailJobId = data.bulkEmailJobId;
  if (!bulkEmailJobId) {
    log.warn(
      { orgId: data.orgId },
      "Bulk email job dispatched without bulkEmailJobId — nothing to do",
    );
    return { sent: 0, failed: 0, skipped: 0 };
  }

  // Load the tracking row + flip to `processing` in one round-trip. If the
  // row was already terminal (a duplicate-delivery retry of the BullMQ
  // job, e.g. job-id re-add during a Redis hand-off), short-circuit so
  // we don't accidentally fan out to recipients twice. The transition is
  // idempotent: status moves from `pending` to `processing` once.
  const tracking = await withWorkerContext(data.orgId, async (tx) => {
    const [row] = await tx
      .select({
        id: bulkEmailJobs.id,
        status: bulkEmailJobs.status,
        subject: bulkEmailJobs.subject,
        body: bulkEmailJobs.body,
        constituentIds: bulkEmailJobs.constituentIds,
        deliveredConstituentIds: bulkEmailJobs.deliveredConstituentIds,
        failedConstituentIds: bulkEmailJobs.failedConstituentIds,
        totalRecipients: bulkEmailJobs.totalRecipients,
      })
      .from(bulkEmailJobs)
      .where(
        and(
          eq(bulkEmailJobs.id, bulkEmailJobId),
          eq(bulkEmailJobs.orgId, data.orgId),
          isNull(bulkEmailJobs.deletedAt),
        ),
      );
    if (!row) return null;

    // Already terminal — duplicate retry. Don't re-run.
    if (row.status === "completed" || row.status === "partial" || row.status === "failed") {
      return { ...row, alreadyTerminal: true };
    }

    await tx
      .update(bulkEmailJobs)
      .set({ status: "processing", updatedAt: new Date() })
      // Defence in depth (issue #430): every sibling statement filters
      // by `eq(bulkEmailJobs.orgId, data.orgId)` — this one regressed.
      .where(and(eq(bulkEmailJobs.id, bulkEmailJobId), eq(bulkEmailJobs.orgId, data.orgId)));
    return { ...row, alreadyTerminal: false };
  });

  if (!tracking) {
    log.warn({ bulkEmailJobId }, "Bulk email job row not found — outbox/DB drift");
    return { sent: 0, failed: 0, skipped: 0 };
  }
  if (tracking.alreadyTerminal) {
    log.info(
      { bulkEmailJobId, status: tracking.status },
      "Bulk email job already terminal — skipping duplicate retry",
    );
    return { sent: 0, failed: 0, skipped: 0 };
  }

  // Compute the work list: recipients in the snapshot who have NOT yet
  // been delivered AND have NOT yet been recorded as failed. On a fresh
  // job both sets are empty so this is just `constituent_ids`. On a
  // retry-after-partial (e.g. a BullMQ retry that the queue itself
  // recovered, rather than a Resume) this skips the recipients the
  // previous attempt already handled — same idempotency posture as the
  // postal-export retry path.
  const delivered = new Set(tracking.deliveredConstituentIds ?? []);
  const previouslyFailed = new Set(tracking.failedConstituentIds ?? []);
  const targetIds = (tracking.constituentIds ?? []).filter(
    (id) => !delivered.has(id) && !previouslyFailed.has(id),
  );

  if (targetIds.length === 0) {
    // Nothing left to do; finalise immediately.
    await finaliseJob(data.orgId, bulkEmailJobId, null, log);
    return { sent: 0, failed: 0, skipped: 0 };
  }

  // Re-fetch contact details under the worker's RLS context. Soft-deleted
  // constituents (deletedAt IS NOT NULL) are excluded so a right-to-erasure
  // request that lands between API enqueue and worker dispatch is honoured.
  const recipients = await withWorkerContext(data.orgId, async (tx) => {
    return tx
      .select({
        id: constituents.id,
        email: constituents.email,
        firstName: constituents.firstName,
        lastName: constituents.lastName,
      })
      .from(constituents)
      .where(
        and(
          inArray(constituents.id, targetIds),
          eq(constituents.orgId, data.orgId),
          isNull(constituents.deletedAt),
          isNotNull(constituents.email),
        ),
      );
  });

  let sent = 0;
  let failed = 0;
  // `targetIds.length - recipients.length` = silently-dropped constituents
  // (soft-deleted between request and send, or had their email cleared).
  // Don't write them into the failed set: a GDPR-erased constituent
  // SHOULDN'T appear in the operator's failed list. Just log + count.
  const skipped = targetIds.length - recipients.length;

  for (const recipient of recipients) {
    if (!recipient.email) {
      // Defensive — `isNotNull(email)` should have filtered these.
      continue;
    }
    try {
      await sender.send({
        to: recipient.email,
        subject: tracking.subject,
        html: renderHtml(tracking.subject, tracking.body, recipient.firstName),
        text: renderText(tracking.body, recipient.firstName),
      });
      sent += 1;
      await recordOutcome(data.orgId, bulkEmailJobId, recipient.id, "delivered");
    } catch (err) {
      failed += 1;
      log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          constituentId: recipient.id,
          bulkEmailJobId,
        },
        "Bulk email send failed for recipient",
      );
      await recordOutcome(data.orgId, bulkEmailJobId, recipient.id, "failed");
    }
  }

  await finaliseJob(data.orgId, bulkEmailJobId, null, log);

  log.info(
    { sent, failed, skipped, total: targetIds.length, bulkEmailJobId },
    "Bulk email job complete",
  );
  return { sent, failed, skipped };
}

/**
 * Atomically append a recipient id to one of the outcome arrays AND keep
 * the count column in step. The CHECK constraint in migration 0045 rejects
 * any UPDATE that lets the count drift from the array length, so we have
 * to update both columns in the same statement.
 *
 * Per-recipient round-trip is intentional — it makes the polling UI live
 * AND means the next worker process can pick up exactly where this one
 * left off if it dies mid-send.
 */
async function recordOutcome(
  orgId: string,
  bulkEmailJobId: string,
  constituentId: string,
  outcome: "delivered" | "failed",
): Promise<void> {
  if (outcome === "delivered") {
    await withWorkerContext(orgId, async (tx) => {
      await tx
        .update(bulkEmailJobs)
        .set({
          deliveredConstituentIds: sql`array_append(${bulkEmailJobs.deliveredConstituentIds}, ${constituentId}::uuid)`,
          deliveredCount: sql`${bulkEmailJobs.deliveredCount} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(bulkEmailJobs.id, bulkEmailJobId), eq(bulkEmailJobs.orgId, orgId)));
    });
    return;
  }
  await withWorkerContext(orgId, async (tx) => {
    await tx
      .update(bulkEmailJobs)
      .set({
        failedConstituentIds: sql`array_append(${bulkEmailJobs.failedConstituentIds}, ${constituentId}::uuid)`,
        failedCount: sql`${bulkEmailJobs.failedCount} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(bulkEmailJobs.id, bulkEmailJobId), eq(bulkEmailJobs.orgId, orgId)));
  });
}

/**
 * Flip the row to its terminal state. Computed from the current counter
 * values rather than what THIS run did — handles the BullMQ retry case
 * (previous run delivered to 5/10, dies; retry delivers to 0 because the
 * skip-already-handled filter saw them all done) cleanly.
 *
 * Status mapping:
 *   - delivered_count == total_recipients ⇒ `completed`.
 *   - delivered_count < total_recipients   ⇒ `partial`. The operator UI
 *     surfaces a Resume action. Includes the "some failed" case AND the
 *     "some soft-deleted" case (counts won't match the array union when
 *     constituents were dropped silently at send time).
 *
 * `error` is the worker-level fatal message (NOT per-recipient). We pass
 * `null` on normal completion; the per-recipient SMTP error is already
 * logged + recorded into `failed_constituent_ids`.
 */
async function finaliseJob(
  orgId: string,
  bulkEmailJobId: string,
  error: string | null,
  log: ReturnType<typeof jobLogger>,
): Promise<void> {
  await withWorkerContext(orgId, async (tx) => {
    const [row] = await tx
      .select({
        deliveredCount: bulkEmailJobs.deliveredCount,
        totalRecipients: bulkEmailJobs.totalRecipients,
      })
      .from(bulkEmailJobs)
      .where(and(eq(bulkEmailJobs.id, bulkEmailJobId), eq(bulkEmailJobs.orgId, orgId)));

    if (!row) return;

    const status = row.deliveredCount >= row.totalRecipients ? "completed" : "partial";

    await tx
      .update(bulkEmailJobs)
      .set({
        status,
        error,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(bulkEmailJobs.id, bulkEmailJobId), eq(bulkEmailJobs.orgId, orgId)));

    // PR #352 review M4: promote the partial outcome to a `warn` so SREs
    // can build a Loki alert on `level=warn AND event=bulk_email.partial`
    // without scraping the structured `status` field out of every info
    // line. Successful completions stay at `info` — no signal value.
    const baseFields = {
      bulkEmailJobId,
      status,
      delivered: row.deliveredCount,
      total: row.totalRecipients,
    };
    if (status === "partial") {
      log.warn(
        { ...baseFields, event: "bulk_email.partial" },
        "Bulk email job finalised with partial delivery — operator can Resume",
      );
    } else {
      log.info({ ...baseFields, event: "bulk_email.completed" }, "Bulk email job finalised");
    }
  });
}
