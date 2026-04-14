/** Tenant routes — platform-admin CRUD for organizations */

import { outboxEvents, tenants } from "@givernance/shared/schema";
import { Type } from "@sinclair/typebox";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../lib/db.js";
import { requireAdminSecret } from "../../lib/guards.js";
import {
  DataArrayResponseNoPagination,
  DataResponse,
  ErrorResponses,
  IdParams,
} from "../../lib/schemas.js";

const CreateTenantBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 255 }),
  slug: Type.String({ minLength: 1, maxLength: 100, pattern: "^[a-z0-9-]+$" }),
  plan: Type.Optional(
    Type.Union([Type.Literal("starter"), Type.Literal("pro"), Type.Literal("enterprise")]),
  ),
});

const TenantResponse = Type.Object({
  id: Type.String(),
  name: Type.String(),
  slug: Type.String(),
  plan: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

export async function tenantRoutes(app: FastifyInstance) {
  /** POST /v1/tenants — create a new organization (platform admin only) */
  app.post(
    "/tenants",
    {
      preHandler: requireAdminSecret,
      schema: {
        body: CreateTenantBody,
        response: { 201: DataResponse(TenantResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const body = request.body as { name: string; slug: string; plan?: string };

      // Transactional outbox: insert tenant + outbox event in same transaction.
      // outbox_events has FORCE RLS, so we set tenant context within the transaction
      // using the newly created tenant's ID.
      const result = await db.transaction(async (tx) => {
        const [tenant] = await tx
          .insert(tenants)
          .values({ name: body.name, slug: body.slug, plan: body.plan ?? "starter" })
          .returning();

        // biome-ignore lint/style/noNonNullAssertion: returning() always yields one row for single insert
        const t = tenant!;

        // Set RLS context for outbox_events insert (FORCE RLS is active on that table)
        await tx.execute(sql`SELECT set_config('app.current_org_id', ${t.id}, true)`);
        await tx.insert(outboxEvents).values({
          tenantId: t.id,
          type: "tenant.created",
          payload: { tenantId: t.id, name: t.name, slug: t.slug },
        });

        return tenant;
      });

      return reply.status(201).send({ data: result });
    },
  );

  /** GET /v1/tenants — list all organizations (platform admin only) */
  app.get(
    "/tenants",
    {
      preHandler: requireAdminSecret,
      schema: {
        response: { 200: DataArrayResponseNoPagination(TenantResponse), ...ErrorResponses },
      },
    },
    async (_request, reply) => {
      const all = await db.select().from(tenants);
      return reply.send({ data: all });
    },
  );

  /** GET /v1/tenants/:id — get organization details (platform admin only) */
  app.get(
    "/tenants/:id",
    {
      preHandler: requireAdminSecret,
      schema: {
        params: IdParams,
        response: { 200: DataResponse(TenantResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const [tenant] = await db.select().from(tenants).where(eq(tenants.id, id));

      if (!tenant) {
        return reply.status(404).send({
          type: "https://httpproblems.com/http-status/404",
          title: "Not Found",
          status: 404,
          detail: "Tenant not found",
        });
      }

      return reply.send({ data: tenant });
    },
  );

  /** DELETE /v1/tenants/:id — delete an organization (platform admin only) */
  app.delete(
    "/tenants/:id",
    {
      preHandler: requireAdminSecret,
      schema: {
        params: IdParams,
        response: { 200: DataResponse(TenantResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const [deleted] = await db.delete(tenants).where(eq(tenants.id, id)).returning();

      if (!deleted) {
        return reply.status(404).send({
          type: "https://httpproblems.com/http-status/404",
          title: "Not Found",
          status: 404,
          detail: "Tenant not found",
        });
      }

      return reply.status(200).send({ data: deleted });
    },
  );
}
