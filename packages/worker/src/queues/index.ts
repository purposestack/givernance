/** Queue definitions — create BullMQ Queue instances */

import { defaultJobOptionsFor, QUEUE_NAMES } from "@givernance/shared/jobs";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { env } from "../env.js";

const connection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

/**
 * `defaultJobOptions` are per Queue INSTANCE (not stored in Redis), so every
 * handle that can `add()` must carry the shared retry + retention policy
 * (issue #612).
 */
function queueWithDefaults(name: string): Queue {
  return new Queue(name, { connection, defaultJobOptions: defaultJobOptionsFor(name) });
}

/** Tax receipt generation queue */
export const receiptsQueue = queueWithDefaults(QUEUE_NAMES.RECEIPTS);

/** Bulk email sending queue */
export const emailsQueue = queueWithDefaults(QUEUE_NAMES.EMAILS);

/** Data export queue */
export const exportsQueue = queueWithDefaults(QUEUE_NAMES.EXPORTS);

/** GDPR erasure queue */
export const gdprQueue = queueWithDefaults(QUEUE_NAMES.GDPR);
