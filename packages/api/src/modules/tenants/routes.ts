/** Tenant routes — platform-admin CRUD for organizations */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../lib/db.js'
import { tenants } from '@givernance/shared/schema'

const CreateTenantBody = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric with hyphens'),
  plan: z.enum(['starter', 'pro', 'enterprise']).optional().default('starter'),
})

/** Guard: require x-admin-secret header matching ADMIN_SECRET env var */
async function requireAdminSecret(request: FastifyRequest, reply: FastifyReply) {
  const secret = request.headers['x-admin-secret'] as string | undefined
  const adminSecret = process.env['ADMIN_SECRET']
  if (!secret || !adminSecret || secret !== adminSecret) {
    return reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Invalid admin secret' })
  }
}

export async function tenantRoutes(app: FastifyInstance) {
  /** POST /v1/tenants — create a new organization (platform admin only) */
  app.post('/tenants', { preHandler: requireAdminSecret }, async (request, reply) => {
    const body = CreateTenantBody.parse(request.body)

    const [tenant] = await db
      .insert(tenants)
      .values({ name: body.name, slug: body.slug, plan: body.plan })
      .returning()

    return reply.status(201).send({ data: tenant })
  })

  /** GET /v1/tenants — list all organizations (platform admin only) */
  app.get('/tenants', { preHandler: requireAdminSecret }, async (_request, reply) => {
    const all = await db.select().from(tenants)
    return reply.send({ data: all })
  })

  /** GET /v1/tenants/:id — get organization details (platform admin only) */
  app.get('/tenants/:id', { preHandler: requireAdminSecret }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, id))

    if (!tenant) {
      return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Tenant not found' })
    }

    return reply.send({ data: tenant })
  })
}
