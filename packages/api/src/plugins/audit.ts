/** Audit log middleware — logs all mutating requests */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'

async function audit(app: FastifyInstance) {
  app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    // Only audit mutating methods
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return

    const entry = {
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      userId: request.auth?.userId ?? 'anonymous',
      orgId: request.auth?.orgId ?? 'unknown',
      timestamp: new Date().toISOString(),
      ip: request.ip,
    }

    // TODO: persist to audit_logs table
    request.log.info(entry, 'audit')
  })
}

export const auditPlugin = fp(audit, {
  name: 'audit',
  dependencies: ['auth'],
})
