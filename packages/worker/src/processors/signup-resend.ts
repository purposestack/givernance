/**
 * Signup-resend processor (F3 follow-up to ADR-016 §8 anti-enumeration).
 *
 * The public `POST /v1/public/signup/resend` endpoint enqueues this job and
 * returns 204 immediately — both for matching and non-matching emails —
 * so an attacker cannot tell "email belongs to a pending tenant" from
 * "no match" by timing the HTTP response. The actual lookup-and-rotate
 * runs here.
 *
 * The lookup-and-rotate logic itself lives in
 * `@givernance/shared/signup` so this processor and any API-side test
 * harness share a single implementation.
 *
 * Owner role rationale: the matching SELECT spans tenants and the
 * `signup_verification` invitation joins `users` + `tenants` with no org
 * context — the unauthenticated route has none and the unguessable
 * invitation token is the security boundary. (Same justification as
 * `verifySignup` in the API service.)
 */

import { randomUUID } from "node:crypto";
import type { OutboxMetadata } from "@givernance/shared/schema";
import { type ResendSignupResult, resendSignupVerification } from "@givernance/shared/signup";
import type { Job } from "bullmq";
import { db } from "../lib/db.js";
import { jobLogger } from "../lib/logger.js";
import { redis } from "../lib/redis.js";
import { isValidTraceparent } from "../lib/trace-context.js";

export interface SignupResendJobPayload {
  email: string;
  /**
   * W3C trace-context built by the API route (issue #575). Rides in the
   * job payload because this flow enqueues BullMQ directly (F3
   * constant-time 204) instead of going through the outbox; the processor
   * stamps it onto the `tenant.signup_verification_resent` outbox insert.
   * Absent on jobs enqueued by pre-#575 builds.
   */
  metadata?: OutboxMetadata | null;
}

/**
 * Re-validate the payload's trace metadata before persisting it to the
 * outbox. The API validated the client-controlled headers at ingest
 * (`buildOutboxMetadata`), but the Redis job payload is a second trust
 * boundary — a stale or hand-crafted job must not smuggle an arbitrary
 * string into `outbox_events.metadata`.
 */
function sanitiseJobMetadata(metadata: OutboxMetadata | null | undefined): OutboxMetadata | null {
  if (!metadata?.traceparent || !isValidTraceparent(metadata.traceparent)) return null;
  return metadata;
}

/**
 * Per-email rate limit (SEC-10) — moved off the HTTP route so the resend
 * endpoint's response time is constant across all branches (F3 timing
 * oracle closure, post-review). The Fastify per-IP rate-limit on the
 * route still caps fan-out from any single source; this bucket caps how
 * many invitation-tokens any one inbox can be forced to rotate per hour.
 *
 * Returns `true` when the request may proceed.
 */
async function acceptResendForEmail(email: string): Promise<boolean> {
  const key = `signup:resend:email:${email.trim().toLowerCase()}`;
  const hits = await redis.incr(key);
  if (hits === 1) {
    await redis.expire(key, 60 * 60);
  }
  return hits <= 3;
}

/**
 * Direct callable for tests — avoids spinning up the BullMQ worker.
 *
 * Includes the per-email rate-limit check (since that moved off the HTTP
 * route) so tests that want to exercise the cap can call this directly.
 */
export async function processSignupResendPayload(
  payload: SignupResendJobPayload,
  log = jobLogger({ tenantId: "system" }),
): Promise<ResendSignupResult> {
  const allowed = await acceptResendForEmail(payload.email);
  if (!allowed) {
    log.info(
      { event: "signup.resend", rateLimited: true },
      "resend dropped — per-email cap exhausted",
    );
    return { matched: false };
  }
  return resendSignupVerification(
    db,
    payload.email,
    randomUUID(),
    log,
    sanitiseJobMetadata(payload.metadata),
  );
}

/** BullMQ processor wrapper. */
export async function processSignupResend(job: Job<SignupResendJobPayload>): Promise<void> {
  const log = jobLogger({ jobId: job.id, tenantId: "system" });
  await processSignupResendPayload(job.data, log);
}
