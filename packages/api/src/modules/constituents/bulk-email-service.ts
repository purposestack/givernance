/**
 * Bulk-email service (Epic #274; partial-send + resume per issue #326).
 *
 * The HTTP path:
 *   1. Validates that every targeted constituent belongs to this org and has
 *      an email on file (skipped without one are reported back, not blocked).
 *   2. Inserts a `bulk_email_jobs` row carrying the request snapshot
 *      (subject + body + deliverable id list + 0/total counters) AND a
 *      `communication.bulk_email_requested` outbox event referencing it.
 *      Both writes share one transaction, same pattern as the
 *      postal-export flow (Epic #274) so the outbox event and the
 *      tracking row stay in lockstep.
 *   3. Returns the new job id + dispatch counts so the UI can both
 *      render "12 emails queued, 3 skipped — no address on file" AND
 *      start polling the job for live `delivered / total` progress.
 *
 * The outbox relay forwards the event to the BullMQ `emails` queue, where
 * the `send-bulk-email` processor reads the `bulk_email_jobs` row,
 * re-resolves email + name from the database under the worker's RLS
 * context (PII never lives in the outbox payload nor Redis), and
 * increments `delivered_count` / `failed_count` per recipient. On
 * mid-flight worker death (Redis OOM, accessory reboot, operator wipe)
 * the row stays at its last update — the operator sees the partial
 * ratio and can hit Resume to re-target the remaining recipients
 * (`constituent_ids \ delivered_constituent_ids`).
 *
 * Scope (MVP):
 *   - No template language. The admin types subject + plain-text body in
 *     the UI; we wrap it in a minimal HTML template for delivery.
 *   - No attachment support.
 *   - No scheduled send — dispatch is "send as soon as the worker picks it up".
 *   - No per-recipient personalization beyond the standard salutation.
 */

import {
  type BulkEmailJobStatus,
  bulkEmailJobs,
  constituents,
  type OutboxMetadata,
  outboxEvents,
} from "@givernance/shared/schema";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { withTenantContext } from "../../lib/db.js";
import { resolveInternalUserId } from "../../lib/resolve-user.js";
import { buildOutboxMetadata } from "../../lib/trace-context.js";

export class BulkEmailValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BulkEmailValidationError";
  }
}

export interface BulkEmailInput {
  /** Up to 500 ids per dispatch. The route enforces this; the service trusts the cap. */
  constituentIds: string[];
  subject: string;
  /**
   * Plain-text body — we add a minimal HTML wrapper at send time. Markdown
   * is intentionally NOT supported in MVP; that lands with the template
   * editor in a follow-up.
   */
  body: string;
}

export interface BulkEmailResult {
  /**
   * The `bulk_email_jobs.id` the API just inserted. The UI uses this to
   * start polling `GET /v1/constituents/bulk-email-jobs/:id` for live
   * delivered / total progress.
   */
  jobId: string;
  /** Constituents enqueued for delivery (had an email on file). */
  queued: number;
  /** Constituents dropped because they had no email address. */
  skippedNoEmail: number;
}

/**
 * Dispatch a new bulk email. Inserts both the tracking row and the
 * outbox event in the same transaction so they're either both visible
 * to the relay or neither — no half-states the worker can pick up
 * without the bulk_email_jobs row to update.
 */
export async function dispatchBulkEmail(
  orgId: string,
  userId: string,
  input: BulkEmailInput,
  request?: FastifyRequest,
): Promise<BulkEmailResult> {
  const ids = Array.from(new Set(input.constituentIds.filter(Boolean)));
  if (ids.length === 0) {
    throw new BulkEmailValidationError("Provide at least one recipient");
  }

  // W3C trace-context propagation (PR #352 review — Log-1). Threaded
  // through into the outbox `metadata` column so the relay → BullMQ →
  // worker pipeline can stitch Loki logs back to the originating
  // request. `null` when called outside an HTTP request (tests, internal
  // tooling) — the worker falls back to the outbox row id as the
  // correlator (worker.ts: `extractTraceId(traceparent) ?? id`).
  const metadata: OutboxMetadata | null = request ? buildOutboxMetadata(request) : null;

  return withTenantContext(orgId, async (tx) => {
    // Verify the requested ids belong to this org and are deliverable
    // (have an email). Read only the boolean we need — explicitly avoid
    // pulling email/firstName/lastName into the snapshot so PII is **not**
    // persisted in `bulk_email_jobs.constituent_ids` (a uuid array) nor
    // pushed through Redis as the BullMQ job payload (GDPR Art. 5(1)(e)
    // storage minimisation). The worker re-fetches contact details at
    // send time under its own RLS context.
    const rows = await tx
      .select({
        id: constituents.id,
        hasEmail: sql<boolean>`(${constituents.email} IS NOT NULL AND ${constituents.email} <> '')`,
      })
      .from(constituents)
      .where(
        and(
          inArray(constituents.id, ids),
          eq(constituents.orgId, orgId),
          isNull(constituents.deletedAt),
        ),
      );

    if (rows.length !== ids.length) {
      throw new BulkEmailValidationError(
        "One or more recipients are not in this organization or have been deleted",
      );
    }

    const deliverableIds = rows.filter((r) => r.hasEmail).map((r) => r.id);
    const skippedNoEmail = rows.length - deliverableIds.length;

    // Same translation-on-insert pattern as `startPostalExport`:
    // `requested_by` FKs `users.id` (internal UUID), but `userId` is the
    // JWT subject (= `users.keycloak_id`). resolveInternalUserId returns
    // `null` when the subject doesn't match an active tenant member
    // (pure-impersonation by a platform admin against a tenant they
    // don't belong to) — the audit chain still captures the real actor
    // via the impersonation session id forwarded through the outbox.
    const requestedByInternal = await resolveInternalUserId(tx, orgId, userId);

    const totalRecipients = deliverableIds.length;
    const [job] = await tx
      .insert(bulkEmailJobs)
      .values({
        orgId,
        status: "pending",
        subject: input.subject,
        body: input.body,
        constituentIds: deliverableIds,
        totalRecipients,
        requestedBy: requestedByInternal,
      })
      .returning({ id: bulkEmailJobs.id });

    if (!job) {
      throw new Error("Failed to insert bulk_email_jobs row");
    }

    // Outbox payload is intentionally minimal: only the bulk_email_jobs
    // row id is required to drive the worker. The constituent_ids list
    // lives in the DB row — re-reading it from there (rather than
    // forwarding it through Redis) keeps the BullMQ job payload small
    // AND means a resume's worker reads the freshest "delivered" set,
    // not a stale snapshot.
    //
    // Skip emitting the outbox event entirely when there's nothing to
    // do — a zero-deliverable dispatch (all recipients skipped) would
    // otherwise queue a no-op job. The row is still inserted with
    // `total_recipients = 0` and an immediate `completed` status so the
    // UI shows the dispatch in the recent jobs list.
    if (totalRecipients === 0) {
      await tx
        .update(bulkEmailJobs)
        .set({
          status: "completed",
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(bulkEmailJobs.id, job.id));
      return { jobId: job.id, queued: 0, skippedNoEmail };
    }

    await tx.insert(outboxEvents).values({
      tenantId: orgId,
      type: "communication.bulk_email_requested",
      metadata,
      payload: {
        bulkEmailJobId: job.id,
        requestedBy: userId,
      },
    });

    return { jobId: job.id, queued: totalRecipients, skippedNoEmail };
  });
}

/**
 * Read-only helper used by the route to short-circuit obvious "no recipients
 * have email" cases ahead of dispatch — the UI uses it to gray out the
 * Send button when the current selection has zero deliverable addresses.
 */
export async function countDeliverableRecipients(
  orgId: string,
  constituentIds: string[],
): Promise<number> {
  const ids = Array.from(new Set(constituentIds.filter(Boolean)));
  if (ids.length === 0) return 0;

  return withTenantContext(orgId, async (tx) => {
    const rows = await tx
      .select({ id: constituents.id })
      .from(constituents)
      .where(
        and(
          inArray(constituents.id, ids),
          eq(constituents.orgId, orgId),
          isNull(constituents.deletedAt),
          isNotNull(constituents.email),
        ),
      );
    return rows.length;
  });
}

/**
 * Serialised shape of a `bulk_email_jobs` row exposed to the API +
 * polling UI. ISO-string dates for transport, plain string union for
 * status (no Drizzle types leak through to clients).
 */
export interface BulkEmailJobView {
  id: string;
  status: BulkEmailJobStatus;
  subject: string;
  /**
   * `processing` jobs whose `updated_at` has gone cold (default 10 min)
   * are surfaced to the UI as `stalled`. The schema enum stays a small
   * fixed set; this derived flag lives next to it instead of bloating
   * the enum. The resume endpoint accepts stalled jobs in addition to
   * the natural terminal partial/failed states.
   */
  stalled: boolean;
  totalRecipients: number;
  deliveredCount: number;
  failedCount: number;
  requestedBy: string | null;
  parentJobId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

/**
 * Threshold past which a `processing` job is considered stalled. Chosen
 * to comfortably exceed the longest reasonable per-recipient SMTP send
 * (Mailpit < 1s, Resend < 5s, worst-case retry chain < a few seconds)
 * AND give the operator a clear "this is stuck, not still going" UX.
 * Worker progress updates touch `updated_at` on every send, so a
 * healthy run never goes 10 minutes between ticks.
 */
export const BULK_EMAIL_STALL_MS = 10 * 60 * 1000;

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function isStalled(status: BulkEmailJobStatus, updatedAt: Date | string): boolean {
  if (status !== "processing") return false;
  const updatedMs = updatedAt instanceof Date ? updatedAt.getTime() : Date.parse(String(updatedAt));
  if (!Number.isFinite(updatedMs)) return false;
  return Date.now() - updatedMs > BULK_EMAIL_STALL_MS;
}

function mapJob(row: {
  id: string;
  status: BulkEmailJobStatus;
  subject: string;
  totalRecipients: number;
  deliveredCount: number;
  failedCount: number;
  requestedBy: string | null;
  parentJobId: string | null;
  error: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  completedAt: Date | string | null;
}): BulkEmailJobView {
  return {
    id: row.id,
    status: row.status,
    subject: row.subject,
    stalled: isStalled(row.status, row.updatedAt),
    totalRecipients: row.totalRecipients,
    deliveredCount: row.deliveredCount,
    failedCount: row.failedCount,
    requestedBy: row.requestedBy,
    parentJobId: row.parentJobId,
    error: row.error,
    // biome-ignore lint/style/noNonNullAssertion: Drizzle returns Date for these timestamp columns
    createdAt: toIso(row.createdAt)!,
    // biome-ignore lint/style/noNonNullAssertion: same
    updatedAt: toIso(row.updatedAt)!,
    completedAt: toIso(row.completedAt),
  };
}

/** List the 20 most-recent bulk email jobs for the tenant, newest first. */
export async function listBulkEmailJobs(orgId: string): Promise<BulkEmailJobView[]> {
  return withTenantContext(orgId, async (tx) => {
    const rows = await tx
      .select({
        id: bulkEmailJobs.id,
        status: bulkEmailJobs.status,
        subject: bulkEmailJobs.subject,
        totalRecipients: bulkEmailJobs.totalRecipients,
        deliveredCount: bulkEmailJobs.deliveredCount,
        failedCount: bulkEmailJobs.failedCount,
        requestedBy: bulkEmailJobs.requestedBy,
        parentJobId: bulkEmailJobs.parentJobId,
        error: bulkEmailJobs.error,
        createdAt: bulkEmailJobs.createdAt,
        updatedAt: bulkEmailJobs.updatedAt,
        completedAt: bulkEmailJobs.completedAt,
      })
      .from(bulkEmailJobs)
      .where(and(eq(bulkEmailJobs.orgId, orgId), isNull(bulkEmailJobs.deletedAt)))
      .orderBy(sql`${bulkEmailJobs.createdAt} DESC`)
      .limit(20);
    return rows.map(mapJob);
  });
}

/** Get a single bulk email job by id — used by the polling endpoint. */
export async function getBulkEmailJob(
  orgId: string,
  jobId: string,
): Promise<BulkEmailJobView | null> {
  return withTenantContext(orgId, async (tx) => {
    const [row] = await tx
      .select({
        id: bulkEmailJobs.id,
        status: bulkEmailJobs.status,
        subject: bulkEmailJobs.subject,
        totalRecipients: bulkEmailJobs.totalRecipients,
        deliveredCount: bulkEmailJobs.deliveredCount,
        failedCount: bulkEmailJobs.failedCount,
        requestedBy: bulkEmailJobs.requestedBy,
        parentJobId: bulkEmailJobs.parentJobId,
        error: bulkEmailJobs.error,
        createdAt: bulkEmailJobs.createdAt,
        updatedAt: bulkEmailJobs.updatedAt,
        completedAt: bulkEmailJobs.completedAt,
      })
      .from(bulkEmailJobs)
      .where(
        and(
          eq(bulkEmailJobs.id, jobId),
          eq(bulkEmailJobs.orgId, orgId),
          isNull(bulkEmailJobs.deletedAt),
        ),
      );
    return row ? mapJob(row) : null;
  });
}

/**
 * Structured error code for `resumeBulkEmailJob` — same pattern as
 * `PostalExportError.code` so the route can map each cause to a stable
 * problem-detail title and the UI can branch on it.
 */
export type BulkEmailResumeErrorCode = "job_not_found" | "job_still_running" | "nothing_to_resume";

export class BulkEmailResumeError extends Error {
  constructor(
    message: string,
    public readonly code: BulkEmailResumeErrorCode,
  ) {
    super(message);
    this.name = "BulkEmailResumeError";
  }
}

/**
 * Create a new bulk email job targeting the recipients the source job
 * never reached.
 *
 * Eligibility:
 *   - Source must NOT be `pending` (never picked up) or actively
 *     `processing` with a fresh `updated_at` — otherwise a resume
 *     could race the original worker into double-sending.
 *   - `processing` jobs whose `updated_at` is older than
 *     {@link BULK_EMAIL_STALL_MS} are considered stalled and accepted —
 *     this covers the Redis-wipe / OOM-kill scenario the issue calls
 *     out: the original worker is gone but the row never reached a
 *     terminal state.
 *   - Source must have at least one remaining recipient
 *     (`delivered_count < total_recipients`).
 *
 * The new row carries `parent_job_id = source.id`. Its `constituent_ids`
 * is computed at insert time as `source.constituent_ids \
 * source.delivered_constituent_ids` — this includes both never-attempted
 * and previously-SMTP-failed recipients. The operator's intent is "make
 * sure everyone who hasn't received it gets it", so retrying SMTP
 * failures is the right default.
 */
export async function resumeBulkEmailJob(
  orgId: string,
  userId: string,
  sourceJobId: string,
  request?: FastifyRequest,
): Promise<BulkEmailJobView> {
  const metadata: OutboxMetadata | null = request ? buildOutboxMetadata(request) : null;
  return withTenantContext(orgId, async (tx) => {
    // `FOR UPDATE` on the source row keeps the eligibility check + the
    // child-row INSERT atomic against a concurrent resume call (PR #352
    // multi-agent review — H1). Two operators double-clicking Resume,
    // or a retried 502, would otherwise both pass the gate, both INSERT
    // a child row, and both fan out to the same remaining recipients
    // (every "remaining" donor gets the email twice).
    //
    // The lock is released at tx end. Concurrent readers (the polling
    // GET endpoint) are unaffected — PG's row lock only blocks writers.
    const [source] = await tx
      .select({
        id: bulkEmailJobs.id,
        status: bulkEmailJobs.status,
        subject: bulkEmailJobs.subject,
        body: bulkEmailJobs.body,
        constituentIds: bulkEmailJobs.constituentIds,
        deliveredConstituentIds: bulkEmailJobs.deliveredConstituentIds,
        totalRecipients: bulkEmailJobs.totalRecipients,
        deliveredCount: bulkEmailJobs.deliveredCount,
        updatedAt: bulkEmailJobs.updatedAt,
      })
      .from(bulkEmailJobs)
      .where(
        and(
          eq(bulkEmailJobs.id, sourceJobId),
          eq(bulkEmailJobs.orgId, orgId),
          isNull(bulkEmailJobs.deletedAt),
        ),
      )
      .for("update");

    if (!source) {
      throw new BulkEmailResumeError("Bulk email job not found", "job_not_found");
    }

    // Eligibility gate. `pending` covers "outbox row hasn't been
    // enqueued yet" — resuming would beat the original worker to the
    // recipients. `processing` covers "worker is actively sending" —
    // resume would race it. The only `processing` we accept is a
    // stalled one (no `updated_at` movement in 10+ minutes).
    if (source.status === "pending") {
      throw new BulkEmailResumeError(
        "Source job hasn't been picked up by a worker yet. Wait for it to start.",
        "job_still_running",
      );
    }
    if (source.status === "processing" && !isStalled(source.status, source.updatedAt)) {
      throw new BulkEmailResumeError(
        "Source job is actively delivering. Wait for it to finish or stall.",
        "job_still_running",
      );
    }

    if (source.deliveredCount >= source.totalRecipients) {
      throw new BulkEmailResumeError(
        "Source job already delivered to every recipient — nothing to resume.",
        "nothing_to_resume",
      );
    }

    // Remaining = original set minus already-delivered. The two id
    // arrays are tenant-local; the set-difference is small (≤ 500
    // items per job per route validator) so an in-process compute is
    // fine — keeps the migration single-table and avoids a CTE per
    // resume.
    const deliveredSet = new Set(source.deliveredConstituentIds ?? []);
    const remainingIds = (source.constituentIds ?? []).filter((id) => !deliveredSet.has(id));

    if (remainingIds.length === 0) {
      // Belt-and-braces: counts can drift transiently if a buggy
      // worker mutates only one column, but the DB CHECK constraint
      // prevents that. Still keep the safety net so a future schema
      // change doesn't silently produce a zero-recipient resume.
      throw new BulkEmailResumeError(
        "Source job already delivered to every recipient — nothing to resume.",
        "nothing_to_resume",
      );
    }

    const requestedByInternal = await resolveInternalUserId(tx, orgId, userId);

    const [resumed] = await tx
      .insert(bulkEmailJobs)
      .values({
        orgId,
        status: "pending",
        subject: source.subject,
        body: source.body,
        constituentIds: remainingIds,
        totalRecipients: remainingIds.length,
        requestedBy: requestedByInternal,
        parentJobId: source.id,
      })
      .returning();

    if (!resumed) {
      throw new Error("Failed to insert resume bulk_email_jobs row");
    }

    await tx.insert(outboxEvents).values({
      tenantId: orgId,
      type: "communication.bulk_email_requested",
      metadata,
      payload: {
        bulkEmailJobId: resumed.id,
        requestedBy: userId,
      },
    });

    return mapJob(resumed);
  });
}
