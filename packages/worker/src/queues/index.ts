/** Queue definitions — create BullMQ Queue instances */

import { QUEUE_NAMES } from "@givernance/shared/jobs";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { env } from "../env.js";

const connection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

/** Tax receipt generation queue */
export const receiptsQueue = new Queue(QUEUE_NAMES.RECEIPTS, { connection });

/** Bulk email sending queue */
export const emailsQueue = new Queue(QUEUE_NAMES.EMAILS, { connection });

/** Data export queue */
export const exportsQueue = new Queue(QUEUE_NAMES.EXPORTS, { connection });

/** GDPR erasure queue */
export const gdprQueue = new Queue(QUEUE_NAMES.GDPR, { connection });
