/** Audit routes — paginated audit log for org admins */

import { auditLogs } from "@givernance/shared/schema";
import type { Pagination } from "@givernance/shared/types";
import { PaginationQuerySchema } from "@givernance/shared/validators";
import { desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { db } from "../../lib/db.js";

/** Guard: require org_admin role */
async function requireOrgAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (!request.auth?.userId) {
    return reply
      .status(401)
      .send({ statusCode: 401, error: "Unauthorized", message: "Authentication required" });
  }
  if (request.auth.role !== "org_admin") {
    return reply
      .status(403)
      .send({ statusCode: 403, error: "Forbidden", message: "org_admin role required" });
  }
}

export async function auditRoutes(app: FastifyInstance) {
  /** GET /v1/audit — list audit logs for current tenant (org_admin only, paginated) */
  app.get("/audit", { preHandler: requireOrgAdmin }, async (request, reply) => {
    const query = PaginationQuerySchema.parse(request.query);
    const { page, perPage } = query;
    const offset = (page - 1) * perPage;
    // auth is guaranteed non-null by requireOrgAdmin guard
    const { orgId } = request.auth!;

    const [data, countResult] = await Promise.all([
      db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.orgId, orgId))
        .orderBy(desc(auditLogs.createdAt))
        .limit(perPage)
        .offset(offset),
      db.select({ count: sql<number>`count(*)` }).from(auditLogs).where(eq(auditLogs.orgId, orgId)),
    ]);

    const total = Number(countResult[0]?.count ?? 0);
    const pagination: Pagination = {
      page,
      perPage,
      total,
      totalPages: Math.ceil(total / perPage),
    };

    return reply.send({ data, pagination });
  });
}
