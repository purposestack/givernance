/** Audit routes — paginated audit log for org admins */

import { auditLogs } from "@givernance/shared/schema";
import type { Pagination } from "@givernance/shared/types";
import { PaginationQuerySchema } from "@givernance/shared/validators";
import { desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { withTenantContext } from "../../lib/db.js";
import { requireOrgAdmin } from "../../lib/guards.js";

export async function auditRoutes(app: FastifyInstance) {
  /** GET /v1/audit — list audit logs for current tenant (org_admin only, paginated) */
  app.get("/audit", { preHandler: requireOrgAdmin }, async (request, reply) => {
    const query = PaginationQuerySchema.parse(request.query);
    const { page, perPage } = query;
    const offset = (page - 1) * perPage;
    const orgId = request.auth?.orgId as string;

    const { data, pagination } = await withTenantContext(orgId, async (tx) => {
      const [rows, countResult] = await Promise.all([
        tx
          .select()
          .from(auditLogs)
          .where(eq(auditLogs.orgId, orgId))
          .orderBy(desc(auditLogs.createdAt))
          .limit(perPage)
          .offset(offset),
        tx.select({ count: sql<number>`count(*)` }).from(auditLogs).where(eq(auditLogs.orgId, orgId)),
      ]);

      const total = Number(countResult[0]?.count ?? 0);
      const pag: Pagination = {
        page,
        perPage,
        total,
        totalPages: Math.ceil(total / perPage),
      };

      return { data: rows, pagination: pag };
    });

    return reply.send({ data, pagination });
  });
}
