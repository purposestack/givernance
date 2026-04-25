/** BullMQ Worker entry point — registers all job processors */

import { QUEUE_NAMES, TENANT_LIFECYCLE_JOBS } from "@givernance/shared/jobs";
import type { Job } from "bullmq";
import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { env } from "./env.js";
import { jobLogger, logger } from "./lib/logger.js";
import { extractTraceId } from "./lib/trace-context.js";
import { processGenerateCampaignDocuments } from "./processors/campaign-documents.js";
import { processGdprErasure } from "./processors/gdpr-erasure.js";
import { processGenerateReceipt } from "./processors/generate-receipt.js";
import { processSendBulkEmail } from "./processors/send-bulk-email.js";
import {
  processSignupVerificationEmail,
  type SignupEmailJobPayload,
} from "./processors/signup-email.js";
import { processStripeWebhook } from "./processors/stripe-webhook.js";
import {
  processTeamInviteEmail,
  type TeamInviteEmailJobPayload,
} from "./processors/team-invite-email.js";
import { processTenantLifecycle } from "./processors/tenant-lifecycle.js";

/** Create a fresh ioredis connection — BullMQ requires separate connections for Queue vs Worker */
function createRedisConnection() {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

/** Queue handles use their own Redis connection (separate from workers) */
const queueConnection = createRedisConnection();
const receiptsQueue = new Queue(QUEUE_NAMES.RECEIPTS, { connection: queueConnection });
const campaignsQueue = new Queue(QUEUE_NAMES.CAMPAIGNS, { connection: queueConnection });
const tenantLifecycleQueue = new Queue(QUEUE_NAMES.TENANT_LIFECYCLE, {
  connection: queueConnection,
});

/**
 * Register the nightly provisional-admin expire job.
 *
 * Runs at 03:15 UTC daily — after the busy EU evening window, before the
 * morning support shift. `jobId` is fixed so re-registering across worker
 * restarts doesn't fan-out to duplicate repeatable schedules.
 */
async function scheduleRepeatableJobs() {
  await tenantLifecycleQueue.add(
    TENANT_LIFECYCLE_JOBS.PROVISIONAL_ADMIN_EXPIRE,
    {},
    {
      jobId: "tenant-provisional-admin-expire-daily",
      repeat: { pattern: "15 3 * * *", tz: "UTC" },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
    },
  );
}

/**
 * Process a domain event from the transactional outbox relay.
 * Routes events to specific handlers based on type.
 */
async function processDomainEvent(job: Job): Promise<void> {
  const { id, tenantId, type, payload, traceparent } = job.data as {
    id: string;
    tenantId: string;
    type: string;
    payload: Record<string, unknown>;
    traceparent?: string;
  };

  // Prefer the W3C trace-id threaded from the API → outbox → relay. Falling
  // back to the outbox event id keeps historical jobs (pre-metadata column)
  // still queryable by a single correlator.
  const traceId = extractTraceId(traceparent) ?? id;

  const log = jobLogger({ tenantId, jobId: job.id, traceId });

  log.info({ eventType: type }, "Processing domain event");

  if (type === "donation.created") {
    const donationId = payload.donationId as string;
    const fiscalYear = new Date().getFullYear();

    // Forward traceparent so the child job's jobLogger inherits the same
    // trace-id — Loki can reconstruct "API request → event → receipt".
    await receiptsQueue.add(
      "generate-receipt",
      {
        donationId,
        orgId: tenantId,
        fiscalYear,
        locale: "en",
        traceparent,
      },
      { jobId: `receipt-${donationId}` },
    );

    log.info({ donationId }, "Enqueued receipt generation");
    return;
  }

  if (type === "campaign.documents_requested") {
    const campaignId = payload.campaignId as string;
    const constituentIds = payload.constituentIds as string[];

    await campaignsQueue.add(
      "generate-campaign-documents",
      {
        campaignId,
        orgId: tenantId,
        constituentIds,
        traceparent,
      },
      { jobId: `campaign-docs-${campaignId}` },
    );

    log.info({ campaignId }, "Enqueued campaign document generation");
    return;
  }

  if (
    type === "tenant.signup_verification_requested" ||
    type === "tenant.signup_verification_resent"
  ) {
    const emailPayload: SignupEmailJobPayload = {
      tenantId,
      invitationId: payload.invitationId as string,
      expiresAt: payload.expiresAt as string,
      country: typeof payload.country === "string" ? payload.country : undefined,
    };
    const result = await processSignupVerificationEmail(emailPayload);
    // `not_found` / `already_accepted` are terminal no-ops (old token rotated,
    // or user already verified) — do not throw, the outbox event is done.
    log.info({ invitationId: emailPayload.invitationId, ...result }, "Signup email dispatched");
    return;
  }

  if (
    type === "invitation.created" ||
    type === "invitation.resent" ||
    type === "tenant.first_admin_invited"
  ) {
    const invitationId = payload.invitationId as string;
    const inviterUserId = typeof payload.inviterUserId === "string" ? payload.inviterUserId : null;
    const country = typeof payload.country === "string" ? payload.country : undefined;
    const emailPayload: TeamInviteEmailJobPayload = {
      tenantId,
      invitationId,
      inviterUserId,
      country,
    };
    const result = await processTeamInviteEmail(emailPayload);
    log.info({ invitationId, eventType: type, ...result }, "Team-invite email dispatched");
    return;
  }

  log.warn({ eventType: type }, "Unhandled event type");
}

/** Start all queue workers */
function startWorkers() {
  const defaultJobOpts = {
    attempts: 3,
    backoff: { type: "exponential" as const, delay: 5000 },
  };

  /** Each Worker gets its own Redis connection per BullMQ best practices */
  const receiptsWorker = new Worker(QUEUE_NAMES.RECEIPTS, processGenerateReceipt, {
    connection: createRedisConnection(),
    concurrency: 5,
    ...defaultJobOpts,
  });

  const emailsWorker = new Worker(QUEUE_NAMES.EMAILS, processSendBulkEmail, {
    connection: createRedisConnection(),
    concurrency: 2,
    ...defaultJobOpts,
  });

  const gdprWorker = new Worker(QUEUE_NAMES.GDPR, processGdprErasure, {
    connection: createRedisConnection(),
    concurrency: 1,
    ...defaultJobOpts,
  });

  const campaignsWorker = new Worker(QUEUE_NAMES.CAMPAIGNS, processGenerateCampaignDocuments, {
    connection: createRedisConnection(),
    concurrency: 3,
    ...defaultJobOpts,
  });

  const eventsWorker = new Worker(QUEUE_NAMES.EVENTS, processDomainEvent, {
    connection: createRedisConnection(),
    concurrency: 10,
    ...defaultJobOpts,
  });

  const webhooksWorker = new Worker(QUEUE_NAMES.WEBHOOKS, processStripeWebhook, {
    connection: createRedisConnection(),
    concurrency: 5,
    ...defaultJobOpts,
  });

  const tenantLifecycleWorker = new Worker(QUEUE_NAMES.TENANT_LIFECYCLE, processTenantLifecycle, {
    connection: createRedisConnection(),
    concurrency: 1,
    ...defaultJobOpts,
  });

  const workers = [
    receiptsWorker,
    emailsWorker,
    gdprWorker,
    campaignsWorker,
    eventsWorker,
    webhooksWorker,
    tenantLifecycleWorker,
  ];

  for (const w of workers) {
    w.on("completed", (job) => {
      logger.info({ worker: w.name, jobId: job.id }, "Job completed");
    });
    w.on("failed", (job, err) => {
      // Distinguish TRANSIENT failures (will be retried) from TERMINAL failures
      // (attempts exhausted → job is on its way to BullMQ's `failed` set).
      // The terminal case is a Dead-Letter event and demands an alert-worthy
      // log line so Loki/Sentry can fire on it. See docs/17 §DLQ and
      // follow-up ADR drafted in issue #56.
      const attemptsMade = job?.attemptsMade ?? 0;
      const maxAttempts = job?.opts?.attempts ?? 1;
      const terminal = attemptsMade >= maxAttempts;
      const payload = {
        worker: w.name,
        jobId: job?.id,
        jobName: job?.name,
        tenantId: (job?.data as { tenantId?: string } | undefined)?.tenantId,
        attemptsMade,
        maxAttempts,
        err: err.message,
        stack: err.stack,
      };
      if (terminal) {
        logger.error({ ...payload, dlq: true }, "Job failed terminally (DLQ candidate)");
      } else {
        logger.warn(payload, "Job failed (will retry)");
      }
    });
  }

  logger.info({ workers: workers.map((w) => w.name) }, "Workers started");
}

startWorkers();
scheduleRepeatableJobs().catch((err) => {
  logger.error({ err }, "Failed to schedule repeatable jobs");
});
