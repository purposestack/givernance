/** Tenant routes — platform-admin CRUD for organizations */

import { outboxEvents, tenants } from "@givernance/shared/schema";
import { Type } from "@sinclair/typebox";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../lib/db.js";
import { requireAdminSecret, requireSuperAdminOrOwnOrgAdmin } from "../../lib/guards.js";
import { resolveTranslations } from "../../lib/i18n.js";
import {
  DataArrayResponseNoPagination,
  DataResponse,
  ErrorResponses,
  IdParams,
  UuidSchema,
} from "../../lib/schemas.js";
import { getTenantSnapshot } from "./service.js";

const CreateTenantBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 255 }),
  slug: Type.String({ minLength: 1, maxLength: 100, pattern: "^[a-z0-9-]+$" }),
  plan: Type.Optional(
    Type.Union([Type.Literal("starter"), Type.Literal("pro"), Type.Literal("enterprise")]),
  ),
});

const TenantBaseCurrencySchema = Type.Union([
  Type.Literal("EUR"),
  Type.Literal("GBP"),
  Type.Literal("CHF"),
]);

const UpdateTenantBody = Type.Object(
  {
    baseCurrency: Type.Optional(TenantBaseCurrencySchema),
  },
  { minProperties: 1 },
);

const TenantResponse = Type.Object({
  id: UuidSchema,
  name: Type.String(),
  slug: Type.String(),
  plan: Type.String(),
  baseCurrency: TenantBaseCurrencySchema,
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

const OrgIdParams = Type.Object({ orgId: UuidSchema });

const SnapshotCampaignResponse = Type.Object({
  id: UuidSchema,
  orgId: UuidSchema,
  name: Type.String(),
  type: Type.String(),
  status: Type.String(),
  parentId: Type.Union([UuidSchema, Type.Null()]),
  costCents: Type.Union([Type.Integer(), Type.Null()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

const SnapshotConstituentResponse = Type.Object({
  id: UuidSchema,
  orgId: UuidSchema,
  firstName: Type.String(),
  lastName: Type.String(),
  email: Type.Union([Type.String(), Type.Null()]),
  phone: Type.Union([Type.String(), Type.Null()]),
  type: Type.String(),
  tags: Type.Union([Type.Array(Type.String()), Type.Null()]),
  deletedAt: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

const SnapshotDonationResponse = Type.Object({
  id: UuidSchema,
  orgId: UuidSchema,
  constituentId: UuidSchema,
  amountCents: Type.Integer(),
  currency: Type.String(),
  campaignId: Type.Union([UuidSchema, Type.Null()]),
  paymentMethod: Type.Union([Type.String(), Type.Null()]),
  paymentRef: Type.Union([Type.String(), Type.Null()]),
  donatedAt: Type.String(),
  fiscalYear: Type.Union([Type.Integer(), Type.Null()]),
  receiptNumber: Type.Union([Type.String(), Type.Null()]),
  receiptAmount: Type.Union([Type.String(), Type.Number(), Type.Null()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

const TenantSnapshotResponse = Type.Object({
  orgId: UuidSchema,
  exportedAt: Type.String(),
  campaigns: Type.Array(SnapshotCampaignResponse),
  constituents: Type.Array(SnapshotConstituentResponse),
  donations: Type.Array(SnapshotDonationResponse),
});

export async function tenantRoutes(app: FastifyInstance) {
  /** GET /v1/admin/tenants/:orgId — fetch tenant settings for the owning org admin */
  app.get(
    "/admin/tenants/:orgId",
    {
      preHandler: requireSuperAdminOrOwnOrgAdmin,
      schema: {
        tags: ["Admin"],
        params: OrgIdParams,
        response: { 200: DataResponse(TenantResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const { orgId } = request.params as { orgId: string };
      const [tenant] = await db.select().from(tenants).where(eq(tenants.id, orgId));

      if (!tenant) {
        const t = resolveTranslations(request);
        return reply.status(404).send({
          type: "https://httpproblems.com/http-status/404",
          title: "Not Found",
          status: 404,
          detail: t("errors.notFound", { resource: t("resources.tenant") }),
        });
      }

      return reply.send({ data: tenant });
    },
  );

  /** PUT /v1/admin/tenants/:orgId — update tenant settings for the owning org admin */
  app.put(
    "/admin/tenants/:orgId",
    {
      preHandler: requireSuperAdminOrOwnOrgAdmin,
      schema: {
        tags: ["Admin"],
        params: OrgIdParams,
        body: UpdateTenantBody,
        response: { 200: DataResponse(TenantResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const { orgId } = request.params as { orgId: string };
      const body = request.body as { baseCurrency?: "EUR" | "GBP" | "CHF" };
      const [updated] = await db
        .update(tenants)
        .set({
          ...(body.baseCurrency ? { baseCurrency: body.baseCurrency } : {}),
          updatedAt: new Date(),
        })
        .where(eq(tenants.id, orgId))
        .returning();

      if (!updated) {
        const t = resolveTranslations(request);
        return reply.status(404).send({
          type: "https://httpproblems.com/http-status/404",
          title: "Not Found",
          status: 404,
          detail: t("errors.notFound", { resource: t("resources.tenant") }),
        });
      }

      return reply.send({ data: updated });
    },
  );

  /** GET /v1/admin/tenants/:orgId/snapshot — export tenant data as JSON */
  app.get(
    "/admin/tenants/:orgId/snapshot",
    {
      preHandler: requireSuperAdminOrOwnOrgAdmin,
      schema: {
        tags: ["Admin"],
        params: OrgIdParams,
        response: { 200: DataResponse(TenantSnapshotResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const { orgId } = request.params as { orgId: string };
      const snapshot = await getTenantSnapshot(orgId);

      if (!snapshot) {
        const t = resolveTranslations(request);
        return reply.status(404).send({
          type: "https://httpproblems.com/http-status/404",
          title: "Not Found",
          status: 404,
          detail: t("errors.notFound", { resource: t("resources.tenant") }),
        });
      }

      return reply.send({ data: snapshot });
    },
  );

  /** POST /v1/tenants — create a new organization (platform admin only) */
  app.post(
    "/tenants",
    {
      preHandler: requireAdminSecret,
      schema: {
        tags: ["Tenants"],
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
        await tx.execute(sql`SELECT set_config('app.current_organization_id', ${t.id}, true)`);
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
        tags: ["Tenants"],
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
        tags: ["Tenants"],
        params: IdParams,
        response: { 200: DataResponse(TenantResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const [tenant] = await db.select().from(tenants).where(eq(tenants.id, id));

      if (!tenant) {
        const t = resolveTranslations(request);
        return reply.status(404).send({
          type: "https://httpproblems.com/http-status/404",
          title: "Not Found",
          status: 404,
          detail: t("errors.notFound", { resource: t("resources.tenant") }),
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
        tags: ["Tenants"],
        params: IdParams,
        response: { 200: DataResponse(TenantResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const [deleted] = await db.delete(tenants).where(eq(tenants.id, id)).returning();

      if (!deleted) {
        const t = resolveTranslations(request);
        return reply.status(404).send({
          type: "https://httpproblems.com/http-status/404",
          title: "Not Found",
          status: 404,
          detail: t("errors.notFound", { resource: t("resources.tenant") }),
        });
      }

      return reply.status(200).send({ data: deleted });
    },
  );
}
