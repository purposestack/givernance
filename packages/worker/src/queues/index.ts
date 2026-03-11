/** Queue definitions — create BullMQ Queue instances */

import { Queue } from 'bullmq'
import Redis from 'ioredis'
import { QUEUE_NAMES } from '@givernance/shared/jobs'

const connection = new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
})

/** Tax receipt generation queue */
export const receiptsQueue = new Queue(QUEUE_NAMES.RECEIPTS, { connection })

/** Bulk email sending queue */
export const emailsQueue = new Queue(QUEUE_NAMES.EMAILS, { connection })

/** Data export queue */
export const exportsQueue = new Queue(QUEUE_NAMES.EXPORTS, { connection })

/** GDPR erasure queue */
export const gdprQueue = new Queue(QUEUE_NAMES.GDPR, { connection })
