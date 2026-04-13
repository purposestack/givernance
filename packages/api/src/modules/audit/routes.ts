/** Audit routes — paginated audit log for org admins */

import { auditLogs } from "@givernance/shared/schema";
import type { Pagination } from "@givernance/shared/types";
import { PaginationQuerySchema } from "@givernance/shared/validators";
import { desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../lib/db.js";
import { requireOrgAdmin } from "../../lib/guards.js";

export async function auditRoutes(app: FastifyInstance) {
  /** GET /v1/audit — list audit logs for current tenant (org_admin only, paginated) */
  app.get("/audit", { preHandler: requireOrgAdmin }, async (request, reply) => {
    const query = PaginationQuerySchema.parse(request.query);
    const { page, perPage } = query;
    const offset = (page - 1) * perPage;
    // requireOrgAdmin guarantees auth is non-null
    const orgId = request.auth?.orgId as string;

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
