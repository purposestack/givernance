/** Constituent routes — GET /v1/constituents, POST /v1/constituents */

import type { FastifyInstance } from 'fastify'
import { ConstituentCreateSchema, PaginationQuerySchema } from '@givernance/shared/validators'
import type { ApiResponse } from '@givernance/shared/types'
import { listConstituents, createConstituent } from './service.js'

export async function constituentRoutes(app: FastifyInstance) {
  /** List constituents with pagination */
  app.get('/constituents', async (request, reply) => {
    const query = PaginationQuerySchema.parse(request.query)
    const orgId = request.auth?.orgId

    if (!orgId) {
      return reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Missing auth context' })
    }

    const result = await listConstituents(orgId, query)
    const response: ApiResponse<typeof result.data> = {
      data: result.data,
      pagination: result.pagination,
    }
    return response
  })

  /** Create a new constituent */
  app.post('/constituents', async (request, reply) => {
    const body = ConstituentCreateSchema.parse(request.body)
    const orgId = request.auth?.orgId

    if (!orgId) {
      return reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Missing auth context' })
    }

    const constituent = await createConstituent(orgId, body)
    return reply.status(201).send({ data: constituent })
  })
}
