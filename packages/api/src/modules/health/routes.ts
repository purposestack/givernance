/** Health check routes — GET /healthz, GET /readyz */

import type { FastifyInstance } from 'fastify'
import { db } from '../../lib/db.js'
import { sql } from 'drizzle-orm'

export async function healthRoutes(app: FastifyInstance) {
  /** Liveness probe — always returns 200 if process is running */
  app.get('/healthz', async () => {
    return { status: 'ok' }
  })

  /** Readiness probe — checks database connectivity */
  app.get('/readyz', async (_request, reply) => {
    try {
      await db.execute(sql`SELECT 1`)
      return { status: 'ready', db: 'ok' }
    } catch {
      return reply.status(503).send({ status: 'not ready', db: 'error' })
    }
  })
}
