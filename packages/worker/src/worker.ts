/** BullMQ Worker entry point — registers all job processors */

import { QUEUE_NAMES, TENANT_LIFECYCLE_JOBS } from "@givernance/shared/jobs";
import type { Job } from "bullmq";
import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { env } from "./env.js";
import { jobLogger, logger } from "./lib/logger.js";
import { processGenerateCampaignDocuments } from "./processors/campaign-documents.js";
import { processGdprErasure } from "./processors/gdpr-erasure.js";
import { processGenerateReceipt } from "./processors/generate-receipt.js";
import { processSendBulkEmail } from "./processors/send-bulk-email.js";
import { processStripeWebhook } from "./processors/stripe-webhook.js";
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
  const { id, tenantId, type, payload } = job.data as {
    id: string;
    tenantId: string;
    type: string;
    payload: Record<string, unknown>;
  };

  const log = jobLogger({ tenantId, jobId: job.id, traceId: id });

  log.info({ eventType: type }, "Processing domain event");

  if (type === "donation.created") {
    const donationId = payload.donationId as string;
    const fiscalYear = new Date().getFullYear();

    await receiptsQueue.add(
      "generate-receipt",
      {
        donationId,
        orgId: tenantId,
        fiscalYear,
        locale: "en",
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
      },
      { jobId: `campaign-docs-${campaignId}` },
    );

    log.info({ campaignId }, "Enqueued campaign document generation");
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
      logger.error({ worker: w.name, jobId: job?.id, err: err.message }, "Job failed");
    });
  }

  logger.info({ workers: workers.map((w) => w.name) }, "Workers started");
}

startWorkers();
scheduleRepeatableJobs().catch((err) => {
  logger.error({ err }, "Failed to schedule repeatable jobs");
});
