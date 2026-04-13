/** BullMQ Worker entry point — registers all job processors */

import { QUEUE_NAMES } from "@givernance/shared/jobs";
import type { Job } from "bullmq";
import { Worker } from "bullmq";
import Redis from "ioredis";
import { processGdprErasure } from "./processors/gdpr-erasure.js";
import { processGenerateReceipt } from "./processors/generate-receipt.js";
import { processSendBulkEmail } from "./processors/send-bulk-email.js";

const connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

/**
 * Process a domain event from the transactional outbox relay.
 * This is the end of the pipeline:
 *   DB tx (mutation + outbox row) → outbox relay → BullMQ → this worker.
 *
 * In Phase 1+ each event type will be routed to its own handler.
 */
async function processDomainEvent(job: Job): Promise<void> {
  const { id, tenantId, type, payload } = job.data as {
    id: string;
    tenantId: string;
    type: string;
    payload: unknown;
  };

  // Worker process — stderr is the correct output stream for operational logs
  console.warn(`[events] Processing domain event: type=${type} id=${id} tenant=${tenantId}`);
  console.warn(`[events] Payload: ${JSON.stringify(payload)}`);
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

  const eventsWorker = new Worker(QUEUE_NAMES.EVENTS, processDomainEvent, {
    connection,
    concurrency: 10,
    ...defaultJobOpts,
  });

  const workers = [receiptsWorker, emailsWorker, gdprWorker, eventsWorker];

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
