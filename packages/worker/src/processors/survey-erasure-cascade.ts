/**
 * Survey erasure cascade — GDPR Art. 17 right-to-erasure (Epic #434, issue #439).
 *
 * Triggered by the `user.soft_deleted` outbox event the
 * `DELETE /v1/users/:id` route emits inside its soft-delete transaction
 * (see `packages/api/src/modules/users/routes.ts`). The cascade has two
 * jobs:
 *
 *  1. For every `survey_invitations` row pointing at the soft-deleted
 *     user, NULL the `user_id` pointer. The FK definition is
 *     `ON DELETE SET NULL` — but the FK only fires on a hard delete of
 *     the users row, and per CLAUDE.md "Soft-delete is universal" we
 *     NEVER hard-delete. So the cascade has to be explicit: an
 *     application-level NULL pass that preserves the row (and the
 *     aggregate response count it backs) while dropping the identity
 *     pointer that links the response to the natural person.
 *
 *  2. Emit one `audit_logs` row per affected invitation with
 *     `action='erasure'`, `resource_type='survey_invitation'`,
 *     `resource_id=<invitation_id>`, `metadata={ user_id, reason:
 *     'user_erasure_cascade' }`. The immutable audit trail is the
 *     evidence a future DPO / SAR audit relies on — per-row, not
 *     aggregated, because GDPR accountability is per-record.
 *
 *  Note: `survey_responses` does NOT carry `user_id`. The user link
 *  goes through the invitation only. NULLing the invitation pointer
 *  therefore severs every response from its answerer in one pass —
 *  the response row and its content (numeric + reviewed free-text)
 *  remain queryable in aggregate, but the natural-person bridge is
 *  gone.
 *
 * Idempotency: re-delivery of the same outbox event is a no-op.
 * `UPDATE … WHERE user_id = $1 AND deleted_at IS NULL` only matches
 * rows that still carry the pointer; a second run finds zero rows. We
 * still emit a SINGLE summary "no-op" audit row in that case so the
 * trail records the redelivery (not the per-invitation rows, since
 * those audit entries already exist from the first run).
 *
 * Connection: uses `db` (the worker's owner pool — BYPASSRLS) and not
 * `withWorkerContext`. The cascade is intentionally CROSS-TENANT-safe-
 * by-construction: every UPDATE/INSERT is gated on the
 * `user_id` + `org_id` pair from the outbox payload, and the
 * outbox event itself was written under tenant context (the API route
 * is `requireOrgAdmin`-gated on the tenant whose user is being
 * deleted). The owner pool is needed because:
 *   - The cascade emits to `audit_logs` for an org that may have RLS
 *     policies the worker's app role doesn't satisfy in time (the
 *     race between the soft-delete tx commit and this consumer
 *     reading the user row is empirically tight on staging).
 *   - This is the same pattern the existing `tenant-lifecycle` and
 *     other cross-tenant cascade processors use.
 * Per the CLAUDE.md "RLS is the safety net, never the contract"
 * rule the explicit `eq(orgId, …)` predicate is on every query.
 */

import { auditLogs, surveyInvitations } from "@givernance/shared/schema";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../lib/db.js";
import { jobLogger } from "../lib/logger.js";
import { extractTraceId } from "../lib/trace-context.js";

export interface SurveyErasureCascadeInput {
  /** Outbox event id — written into audit metadata for trace correlation. */
  outboxId: string;
  /** Tenant scope — captured at outbox write time. */
  tenantId: string;
  /** Outbox event type — used as a guard; cascade no-ops on a mismatched type. */
  type: string;
  /** Outbox event payload (untyped at the boundary). */
  payload: Record<string, unknown>;
  /** W3C trace context for logger correlation. */
  traceparent?: string;
}

export interface SurveyErasureCascadeResult {
  /** Whether the cascade ran (i.e. the event type matched). */
  matched: boolean;
  /** Number of invitation rows whose user_id was just NULL'd. */
  invitationsNulled: number;
}

/**
 * Side-effect-only helper. Returns a small result for logging /
 * testing; throws if the payload is malformed (the outbox relay's
 * retry policy will then re-deliver). Never throws on "no rows
 * matched" — that's the idempotent path.
 */
export async function cascadeSurveyErasure(
  input: SurveyErasureCascadeInput,
): Promise<SurveyErasureCascadeResult> {
  if (input.type !== "user.soft_deleted") {
    return { matched: false, invitationsNulled: 0 };
  }

  const { payload, tenantId, outboxId } = input;
  const userId = payload.userId;
  const payloadOrgId = payload.orgId;

  if (typeof userId !== "string" || typeof payloadOrgId !== "string") {
    throw new Error(
      `survey-erasure-cascade: malformed payload — expected { userId, orgId } strings, got ${JSON.stringify(payload)}`,
    );
  }

  // Cross-check: the outbox event's `tenantId` and the payload's
  // `orgId` must agree. A divergence means the producer wrote a
  // tenant-scoped event with a foreign user — refuse and let the
  // relay re-deliver into a louder error rather than silently
  // erasing the wrong tenant's invitations.
  if (tenantId !== payloadOrgId) {
    throw new Error(
      `survey-erasure-cascade: tenantId/orgId mismatch (event tenant=${tenantId}, payload org=${payloadOrgId})`,
    );
  }

  const orgId = payloadOrgId;

  // NULL the pointer on every still-pending invitation. Explicit
  // `eq(orgId, …)` per CLAUDE.md "RLS is the safety net" — the owner
  // pool bypasses RLS, so the application predicate is the only
  // tenant boundary on this query.
  const nulled = await db
    .update(surveyInvitations)
    .set({ userId: null })
    .where(
      and(
        eq(surveyInvitations.userId, userId),
        eq(surveyInvitations.orgId, orgId),
        isNull(surveyInvitations.deletedAt),
      ),
    )
    .returning({ id: surveyInvitations.id });

  if (nulled.length === 0) {
    // Idempotent path — no rows owed. Emit a single summary audit
    // row so the redelivery is recorded (the per-invitation rows
    // already exist from the first cascade run).
    await db.insert(auditLogs).values({
      orgId,
      userId: null,
      action: "erasure",
      resourceType: "survey_invitation",
      resourceId: null,
      newValues: {
        userId,
        reason: "user_erasure_cascade",
        outcome: "noop",
        outboxId,
      },
    });
    return { matched: true, invitationsNulled: 0 };
  }

  // Per-row audit entries — GDPR accountability is per-record.
  // Single INSERT statement with `.values([…])` so the worker takes
  // one round-trip even when a power-user has hundreds of pending
  // invitations.
  await db.insert(auditLogs).values(
    nulled.map((row) => ({
      orgId,
      userId: null,
      action: "erasure",
      resourceType: "survey_invitation",
      resourceId: row.id,
      newValues: {
        userId,
        reason: "user_erasure_cascade",
        outboxId,
      },
    })),
  );

  return { matched: true, invitationsNulled: nulled.length };
}

/**
 * Worker-facing fanout wrapper. Mirrors the `fanoutNotifications`
 * shape so registration in `worker.ts` follows the same pattern.
 *
 * Error semantics (GDPR Art. 17 accountability):
 *  - `payload malformed` / `tenantId mismatch`: log at warn and SKIP
 *    (the outbox event itself is structurally wrong; redelivery won't
 *    help and would loop the relay). The audit trail will show no
 *    cascade row for that outbox_id, which is the correct signal.
 *  - DB-error path inside the NULL-cascade transaction: RE-THROW so
 *    the outbox relay retries with backoff. Swallowing a DB failure
 *    here would leave erasure-pending invitation rows still pointing
 *    at the soft-deleted user — a GDPR Art. 17 breach we cannot
 *    silently absorb.
 */
const PAYLOAD_GUARD_PATTERN = /malformed payload|mismatch/i;

export async function fanoutSurveyErasure(input: SurveyErasureCascadeInput): Promise<void> {
  if (input.type !== "user.soft_deleted") return;
  // Same jobLogger shape as sibling processors — the outbox id doubles as
  // the job id, and the traceparent (when the producing request carried one)
  // binds the traceId so Loki stitches the erasure into the request trace.
  const log = jobLogger({
    tenantId: input.tenantId,
    jobId: input.outboxId,
    // Same fallback semantics as worker.ts's processDomainEvent: unstamped
    // (pre-#55) events still get a correlator — the outbox row id.
    traceId: extractTraceId(input.traceparent) ?? input.outboxId,
  });
  try {
    const result = await cascadeSurveyErasure(input);
    log.info(
      {
        outboxId: input.outboxId,
        tenantId: input.tenantId,
        invitationsNulled: result.invitationsNulled,
      },
      "survey-erasure-cascade complete",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (PAYLOAD_GUARD_PATTERN.test(message)) {
      // Structurally bad event — skip; retry would just loop the relay.
      log.warn(
        { err, outboxId: input.outboxId, tenantId: input.tenantId },
        "survey-erasure-cascade skipped (payload guard tripped)",
      );
      return;
    }
    // Real failure (DB, network, constraint) — re-throw so the outbox
    // relay's retry/backoff policy fires. GDPR Art. 17 accountability
    // requires the cascade actually run.
    log.error(
      { err, outboxId: input.outboxId, tenantId: input.tenantId },
      "survey-erasure-cascade failed — re-throwing for relay retry",
    );
    throw err;
  }
}
