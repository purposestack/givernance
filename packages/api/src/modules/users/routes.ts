/** User routes — user profile and org-admin user management */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../lib/db.js'
import { users } from '@givernance/shared/schema'

const CreateUserBody = z.object({
  email: z.string().email(),
  firstName: z.string().min(1).max(255),
  lastName: z.string().min(1).max(255),
  role: z.enum(['org_admin', 'user', 'viewer']).default('user'),
})

const UpdateRoleBody = z.object({
  role: z.enum(['org_admin', 'user', 'viewer']),
})

/** Guard: require valid JWT */
async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  if (!request.auth?.userId) {
    return reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Authentication required' })
  }
}

/** Guard: require org_admin role */
async function requireOrgAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (!request.auth?.userId) {
    return reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Authentication required' })
  }
  if (request.auth.role !== 'org_admin') {
    return reply.status(403).send({ statusCode: 403, error: 'Forbidden', message: 'org_admin role required' })
  }
}

export async function userRoutes(app: FastifyInstance) {
  /** GET /v1/users/me — current user profile (requires JWT) */
  app.get('/users/me', { preHandler: requireAuth }, async (request, reply) => {
    // auth is guaranteed non-null by requireAuth guard
    const auth = request.auth!
    const [user] = await db
      .select()
      .from(users)
      .where(and(eq(users.keycloakId, auth.userId), eq(users.orgId, auth.orgId)))

    if (!user) {
      return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'User profile not found' })
    }

    return reply.send({ data: user })
  })

  /** GET /v1/users — list users in tenant (org_admin only) */
  app.get('/users', { preHandler: requireOrgAdmin }, async (request, reply) => {
    const { orgId } = request.auth!
    const all = await db.select().from(users).where(eq(users.orgId, orgId))
    return reply.send({ data: all })
  })

  /** POST /v1/users — create user in tenant (org_admin only) */
  app.post('/users', { preHandler: requireOrgAdmin }, async (request, reply) => {
    const { orgId } = request.auth!
    const body = CreateUserBody.parse(request.body)

    const [user] = await db
      .insert(users)
      .values({ ...body, orgId })
      .returning()

    return reply.status(201).send({ data: user })
  })

  /** PATCH /v1/users/:id/role — update user role (org_admin only) */
  app.patch('/users/:id/role', { preHandler: requireOrgAdmin }, async (request, reply) => {
    const { orgId } = request.auth!
    const { id } = request.params as { id: string }
    const { role } = UpdateRoleBody.parse(request.body)

    const [updated] = await db
      .update(users)
      .set({ role, updatedAt: new Date() })
      .where(and(eq(users.id, id), eq(users.orgId, orgId)))
      .returning()

    if (!updated) {
      return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'User not found' })
    }

    return reply.send({ data: updated })
  })
}
