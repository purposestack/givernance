/** BullMQ Worker entry point — registers all job processors */

import { Worker } from 'bullmq'
import Redis from 'ioredis'
import { QUEUE_NAMES } from '@givernance/shared/jobs'
import { processGenerateReceipt } from './processors/generate-receipt.js'
import { processSendBulkEmail } from './processors/send-bulk-email.js'
import { processGdprErasure } from './processors/gdpr-erasure.js'

const connection = new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
})

/** Start all queue workers */
function startWorkers() {
  const receiptsWorker = new Worker(QUEUE_NAMES.RECEIPTS, processGenerateReceipt, {
    connection,
    concurrency: 5,
  })

  const emailsWorker = new Worker(QUEUE_NAMES.EMAILS, processSendBulkEmail, {
    connection,
    concurrency: 2,
  })

  const gdprWorker = new Worker(QUEUE_NAMES.GDPR, processGdprErasure, {
    connection,
    concurrency: 1,
  })

  const workers = [receiptsWorker, emailsWorker, gdprWorker]

  for (const w of workers) {
    w.on('completed', (job) => {
      console.error(`[${w.name}] Job ${job.id} completed`)
    })
    w.on('failed', (job, err) => {
      console.error(`[${w.name}] Job ${job?.id} failed:`, err.message)
    })
  }

  console.error(`Workers started: ${workers.map((w) => w.name).join(', ')}`)
}

startWorkers()
