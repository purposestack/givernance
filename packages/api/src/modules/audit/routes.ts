/** Audit routes — paginated audit log for org admins */

import { auditLogs } from "@givernance/shared/schema";
import type { Pagination } from "@givernance/shared/types";
import { PaginationQuerySchema } from "@givernance/shared/validators";
import { Type } from "@sinclair/typebox";
import { desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { withTenantContext } from "../../lib/db.js";
import { requireOrgAdmin } from "../../lib/guards.js";
import { DataArrayResponse, ErrorResponses } from "../../lib/schemas.js";

const AuditLogResponse = Type.Object({
  id: Type.String(),
  orgId: Type.String(),
  userId: Type.Union([Type.String(), Type.Null()]),
  action: Type.String(),
  resourceType: Type.Union([Type.String(), Type.Null()]),
  resourceId: Type.Union([Type.String(), Type.Null()]),
  oldValues: Type.Unknown(),
  newValues: Type.Unknown(),
  ipHash: Type.Union([Type.String(), Type.Null()]),
  userAgent: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
});

export async function auditRoutes(app: FastifyInstance) {
  /** GET /v1/audit — list audit logs for current tenant (org_admin only, paginated) */
  app.get(
    "/audit",
    {
      preHandler: requireOrgAdmin,
      schema: {
        response: { 200: DataArrayResponse(AuditLogResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
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
          tx
            .select({ count: sql<number>`count(*)` })
            .from(auditLogs)
            .where(eq(auditLogs.orgId, orgId)),
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
    },
  );
}
