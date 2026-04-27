/** User routes — user profile and org-admin user management */

import { SUPPORTED_LOCALES } from "@givernance/shared/i18n";
import { auditLogs, outboxEvents, tenants, users } from "@givernance/shared/schema";
import { Type } from "@sinclair/typebox";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { withTenantContext } from "../../lib/db.js";
import { requireAuth, requireOrgAdmin } from "../../lib/guards.js";
import { resolveTranslations } from "../../lib/i18n.js";
import {
  DataArrayResponseNoPagination,
  DataResponse,
  ErrorResponses,
  IdParams,
  UuidSchema,
} from "../../lib/schemas.js";

const UserLocaleSchema = Type.Union(SUPPORTED_LOCALES.map((value) => Type.Literal(value)));

/**
 * Body for `PATCH /v1/users/me` (issue #153). The single-field body keeps
 * the contract minimal — there's no other personal preference exposed
 * yet. Setting `locale: null` clears `users.locale` so the user reverts
 * to inheriting the tenant's `default_locale`.
 */
const UpdateMeBody = Type.Object({
  locale: Type.Union([UserLocaleSchema, Type.Null()]),
});

const CreateUserBody = Type.Object({
  email: Type.String({ format: "email" }),
  firstName: Type.String({ minLength: 1, maxLength: 255 }),
  lastName: Type.String({ minLength: 1, maxLength: 255 }),
  role: Type.Optional(
    Type.Union([Type.Literal("org_admin"), Type.Literal("user"), Type.Literal("viewer")]),
  ),
});

const UpdateRoleBody = Type.Object({
  role: Type.Union([Type.Literal("org_admin"), Type.Literal("user"), Type.Literal("viewer")]),
});

const UserResponse = Type.Object({
  id: UuidSchema,
  orgId: UuidSchema,
  keycloakId: Type.Union([Type.String(), Type.Null()]),
  email: Type.String(),
  firstName: Type.String(),
  lastName: Type.String(),
  role: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

/**
 * Extended `/users/me` payload — includes onboarding-runtime fields
 * (`firstAdmin`, `provisionalUntil`, `orgSlug`) so the app shell can render
 * the provisional-admin banner without a second round-trip.
 *
 * Issue #153: `locale` is the user's personal override (NULL when they
 * inherit the tenant default); `tenantDefaultLocale` is the tenant's
 * `default_locale` so the profile UI can show "Use organisation default"
 * with the actual default value as a hint without a second round-trip.
 */
const MeResponse = Type.Object({
  id: UuidSchema,
  orgId: UuidSchema,
  keycloakId: Type.Union([Type.String(), Type.Null()]),
  email: Type.String(),
  firstName: Type.String(),
  lastName: Type.String(),
  role: Type.String(),
  firstAdmin: Type.Boolean(),
  provisionalUntil: Type.Union([Type.String(), Type.Null()]),
  locale: Type.Union([UserLocaleSchema, Type.Null()]),
  tenantDefaultLocale: UserLocaleSchema,
  orgSlug: Type.String(),
  orgName: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

export async function userRoutes(app: FastifyInstance) {
  /** GET /v1/users/me — current user profile (requires JWT) */
  app.get(
    "/users/me",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Users"],
        response: { 200: DataResponse(MeResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const userId = request.auth?.userId as string;
      const orgId = request.auth?.orgId as string;

      const row = await withTenantContext(orgId, async (tx) => {
        const [r] = await tx
          .select({
            id: users.id,
            orgId: users.orgId,
            keycloakId: users.keycloakId,
            email: users.email,
            firstName: users.firstName,
            lastName: users.lastName,
            role: users.role,
            firstAdmin: users.firstAdmin,
            provisionalUntil: users.provisionalUntil,
            locale: users.locale,
            tenantDefaultLocale: tenants.defaultLocale,
            createdAt: users.createdAt,
            updatedAt: users.updatedAt,
            orgSlug: tenants.slug,
            orgName: tenants.name,
          })
          .from(users)
          .innerJoin(tenants, eq(tenants.id, users.orgId))
          .where(and(eq(users.keycloakId, userId), eq(users.orgId, orgId)));
        return r;
      });

      if (!row) {
        const t = resolveTranslations(request);
        return reply.status(404).send({
          type: "https://httpproblems.com/http-status/404",
          title: "Not Found",
          status: 404,
          detail: t("errors.notFound", { resource: t("resources.user") }),
        });
      }

      return reply.send({
        data: {
          ...row,
          provisionalUntil: row.provisionalUntil?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        },
      });
    },
  );

  /**
   * PATCH /v1/users/me — update the caller's personal preferences (issue #153).
   *
   * Currently exposes only `locale`; the body is shaped as an object so we
   * can grow the surface (timezone, notification preferences, …) without
   * breaking clients. `locale: null` clears `users.locale` so the user
   * reverts to inheriting their tenant's `default_locale`.
   *
   * Auth: any authenticated user — this is the user's own row.
   * Audit: emits `user.preferences_updated` with the field-level diff so a
   * locale flip is reconstructable from the audit trail.
   */
  app.patch(
    "/users/me",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Users"],
        body: UpdateMeBody,
        response: { 200: DataResponse(MeResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const userId = request.auth?.userId as string;
      const orgId = request.auth?.orgId as string;
      const body = request.body as { locale: "en" | "fr" | null };

      const result = await withTenantContext(orgId, async (tx) => {
        // Read the existing locale so the audit `oldValues` carries the
        // pre-update value. The same SELECT also resolves the application
        // user id for the audit row's `userId` column.
        const [existing] = await tx
          .select({ id: users.id, locale: users.locale })
          .from(users)
          .where(and(eq(users.keycloakId, userId), eq(users.orgId, orgId)))
          .limit(1);
        if (!existing) return null;

        const [updated] = await tx
          .update(users)
          .set({ locale: body.locale, updatedAt: new Date() })
          .where(eq(users.id, existing.id))
          .returning({
            id: users.id,
            orgId: users.orgId,
            keycloakId: users.keycloakId,
            email: users.email,
            firstName: users.firstName,
            lastName: users.lastName,
            role: users.role,
            firstAdmin: users.firstAdmin,
            provisionalUntil: users.provisionalUntil,
            locale: users.locale,
            createdAt: users.createdAt,
            updatedAt: users.updatedAt,
          });
        if (!updated) return null;

        await tx.insert(auditLogs).values({
          orgId,
          userId: existing.id,
          action: "user.preferences_updated",
          resourceType: "user",
          resourceId: existing.id,
          oldValues: { locale: existing.locale },
          newValues: { locale: body.locale },
        });

        const [tenantRow] = await tx
          .select({
            slug: tenants.slug,
            name: tenants.name,
            defaultLocale: tenants.defaultLocale,
          })
          .from(tenants)
          .where(eq(tenants.id, orgId))
          .limit(1);
        if (!tenantRow) return null;

        return { user: updated, tenant: tenantRow };
      });

      if (!result) {
        const t = resolveTranslations(request);
        return reply.status(404).send({
          type: "https://httpproblems.com/http-status/404",
          title: "Not Found",
          status: 404,
          detail: t("errors.notFound", { resource: t("resources.user") }),
        });
      }

      return reply.send({
        data: {
          ...result.user,
          provisionalUntil: result.user.provisionalUntil?.toISOString() ?? null,
          createdAt: result.user.createdAt.toISOString(),
          updatedAt: result.user.updatedAt.toISOString(),
          tenantDefaultLocale: result.tenant.defaultLocale,
          orgSlug: result.tenant.slug,
          orgName: result.tenant.name,
        },
      });
    },
  );

  /** GET /v1/users — list users in tenant (org_admin only) */
  app.get(
    "/users",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Users"],
        response: { 200: DataArrayResponseNoPagination(UserResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId as string;
      const all = await withTenantContext(orgId, async (tx) => {
        return tx.select().from(users).where(eq(users.orgId, orgId));
      });
      return reply.send({ data: all });
    },
  );

  /** POST /v1/users — create user in tenant (org_admin only) */
  app.post(
    "/users",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Users"],
        body: CreateUserBody,
        response: { 201: DataResponse(UserResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId as string;
      const body = request.body as {
        email: string;
        firstName: string;
        lastName: string;
        role?: string;
      };

      // withTenantContext already wraps in a transaction — use tx for outbox pattern
      const result = await withTenantContext(orgId, async (tx) => {
        const [inserted] = await tx
          .insert(users)
          .values({
            ...body,
            role: (body.role as "org_admin" | "user" | "viewer") ?? "user",
            orgId,
          })
          .returning();

        // biome-ignore lint/style/noNonNullAssertion: returning() always yields one row for single insert
        const user = inserted!;
        await tx.insert(outboxEvents).values({
          tenantId: orgId,
          type: "user.created",
          payload: { userId: user.id, email: user.email, orgId },
        });

        return user;
      });

      return reply.status(201).send({ data: result });
    },
  );

  /** PATCH /v1/users/:id/role — update user role (org_admin only) */
  app.patch(
    "/users/:id/role",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Users"],
        params: IdParams,
        body: UpdateRoleBody,
        response: { 200: DataResponse(UserResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId as string;
      const { id } = request.params as { id: string };
      const body = request.body as { role: "org_admin" | "user" | "viewer" };

      const updated = await withTenantContext(orgId, async (tx) => {
        const [row] = await tx
          .update(users)
          .set({ role: body.role, updatedAt: new Date() })
          .where(and(eq(users.id, id), eq(users.orgId, orgId)))
          .returning();
        return row;
      });

      if (!updated) {
        const t = resolveTranslations(request);
        return reply.status(404).send({
          type: "https://httpproblems.com/http-status/404",
          title: "Not Found",
          status: 404,
          detail: t("errors.notFound", { resource: t("resources.user") }),
        });
      }

      return reply.send({ data: updated });
    },
  );

  /** DELETE /v1/users/:id — remove user from tenant (org_admin only) */
  app.delete(
    "/users/:id",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Users"],
        params: IdParams,
        response: { 200: DataResponse(UserResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId as string;
      const { id } = request.params as { id: string };

      const deleted = await withTenantContext(orgId, async (tx) => {
        const [row] = await tx
          .delete(users)
          .where(and(eq(users.id, id), eq(users.orgId, orgId)))
          .returning();
        return row;
      });

      if (!deleted) {
        const t = resolveTranslations(request);
        return reply.status(404).send({
          type: "https://httpproblems.com/http-status/404",
          title: "Not Found",
          status: 404,
          detail: t("errors.notFound", { resource: t("resources.user") }),
        });
      }

      return reply.status(200).send({ data: deleted });
    },
  );
}
