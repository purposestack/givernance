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
 */
export async function enqueueSignupResend(email: string): Promise<void> {
  await tenantLifecycleQueue.add(
    TENANT_LIFECYCLE_JOBS.SIGNUP_RESEND,
    { email: email.trim().toLowerCase() },
    {
      removeOnComplete: 1000,
      removeOnFail: 5000,
      // The HTTP per-email bucket (`signup:resend:email:<email>`) already
      // caps fan-out at 3/h, so we don't need a queue-level dedup. A
      // generated jobId keeps each enqueue distinct so a legitimate
      // rotation-after-failure isn't accidentally swallowed.
    },
  );
}
