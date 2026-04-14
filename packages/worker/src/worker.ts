/** BullMQ Worker entry point — registers all job processors */

import { QUEUE_NAMES } from "@givernance/shared/jobs";
import type { Job } from "bullmq";
import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { processGenerateCampaignDocuments } from "./processors/campaign-documents.js";
import { processGdprErasure } from "./processors/gdpr-erasure.js";
import { processGenerateReceipt } from "./processors/generate-receipt.js";
import { processSendBulkEmail } from "./processors/send-bulk-email.js";

const connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

/** Queue handle for enqueuing receipt generation jobs */
const receiptsQueue = new Queue(QUEUE_NAMES.RECEIPTS, { connection });

/** Queue handle for enqueuing campaign document generation jobs */
const campaignsQueue = new Queue(QUEUE_NAMES.CAMPAIGNS, { connection });

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

  console.warn(`[events] Processing domain event: type=${type} id=${id} tenant=${tenantId}`);

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

    console.warn(`[events] Enqueued receipt generation for donation ${donationId}`);
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

    console.warn(`[events] Enqueued campaign document generation for campaign ${campaignId}`);
    return;
  }

  console.warn(`[events] Unhandled event type: ${type}`);
}

/** Start all queue workers */
function startWorkers() {
  const defaultJobOpts = {
    attempts: 3,
    backoff: { type: "exponential" as const, delay: 1000 },
  };

  const receiptsWorker = new Worker(QUEUE_NAMES.RECEIPTS, processGenerateReceipt, {
    connection,
    concurrency: 5,
    ...defaultJobOpts,
  });

  const emailsWorker = new Worker(QUEUE_NAMES.EMAILS, processSendBulkEmail, {
    connection,
    concurrency: 2,
    ...defaultJobOpts,
  });

  const gdprWorker = new Worker(QUEUE_NAMES.GDPR, processGdprErasure, {
    connection,
    concurrency: 1,
    ...defaultJobOpts,
  });

  const campaignsWorker = new Worker(QUEUE_NAMES.CAMPAIGNS, processGenerateCampaignDocuments, {
    connection,
    concurrency: 3,
    ...defaultJobOpts,
  });

  const eventsWorker = new Worker(QUEUE_NAMES.EVENTS, processDomainEvent, {
    connection,
    concurrency: 10,
    ...defaultJobOpts,
  });

  const workers = [receiptsWorker, emailsWorker, gdprWorker, campaignsWorker, eventsWorker];

  for (const w of workers) {
    w.on("completed", (job) => {
      console.warn(`[${w.name}] Job ${job.id} completed`);
    });
    w.on("failed", (job, err) => {
      console.error(`[${w.name}] Job ${job?.id} failed:`, err.message);
    });
  }

  console.warn(`Workers started: ${workers.map((w) => w.name).join(", ")}`);
}

startWorkers();
