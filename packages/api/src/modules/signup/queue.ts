/**
 * BullMQ queue handle for deferred public-signup work.
 *
 * F3 — The resend endpoint enqueues onto this queue and returns 204 in
 * constant HTTP time, regardless of whether the email matches a pending
 * tenant. The actual lookup-and-rotate work runs in the worker
 * (`processors/signup-resend.ts`), closing the timing-side-channel that
 * would otherwise let an attacker tell "email matches" from "no match" by
 * comparing response latencies.
 */

import { QUEUE_NAMES, TENANT_LIFECYCLE_JOBS } from "@givernance/shared/jobs";
import { Queue } from "bullmq";
import { redis } from "../../lib/redis.js";

const tenantLifecycleQueue = new Queue(QUEUE_NAMES.TENANT_LIFECYCLE, { connection: redis });

/**
 * Enqueue a deferred resend-verification job. The handler runs in the
 * worker so the public HTTP response stays constant-time across the
 * "matches a candidate" and "no match" branches.
 *
 * `attempts: 1` is deliberate — the processor commits a token rotation
 * (UPDATE invitations) and an outbox INSERT in a single tx. If BullMQ
 * retried after a commit-then-crash mid-ack, the retry would rotate the
 * token again and emit a second `tenant.signup_verification_resent`
 * event, so the user would receive two emails with the first one now
 * carrying a dead token. The per-email rate-limit and the user's own
 * "Try a different email" path are the recovery channels; we'd rather
 * drop a single resend than ship a stale-token email.
 */
export async function enqueueSignupResend(email: string): Promise<void> {
  await tenantLifecycleQueue.add(
    TENANT_LIFECYCLE_JOBS.SIGNUP_RESEND,
    { email: email.trim().toLowerCase() },
    {
      attempts: 1,
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  );
}
