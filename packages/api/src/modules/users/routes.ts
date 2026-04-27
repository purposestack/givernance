/** User routes — user profile and org-admin user management */

import { SUPPORTED_LOCALES } from "@givernance/shared/i18n";
import { auditLogs, outboxEvents, tenants, users } from "@givernance/shared/schema";
import { Type } from "@sinclair/typebox";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { withTenantContext } from "../../lib/db.js";
import { requireAuth, requireOrgAdmin } from "../../lib/guards.js";
import { resolveTranslations } from "../../lib/i18n.js";
import { keycloakAdmin } from "../../lib/keycloak-admin.js";
import {
  DataArrayResponseNoPagination,
  DataResponse,
  ErrorResponses,
  IdParams,
  ProblemDetailSchema,
  problemDetail,
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

const RoleSchema = Type.Union([
  Type.Literal("org_admin"),
  Type.Literal("user"),
  Type.Literal("viewer"),
]);

/**
 * Body for `PATCH /v1/users/:id` (issue #161). Combined endpoint that
 * subsumes the previous role-only PATCH so an org_admin can correct a
 * member's display name (marriage / divorce / typo at signup) and adjust
 * their role from a single dialog. `minProperties: 1` guarantees at least
 * one of the optional fields is present — empty-body PATCHes are a 400
 * rather than a silent no-op so callers don't think they updated something.
 */
const UpdateUserBody = Type.Object(
  {
    firstName: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    lastName: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    role: Type.Optional(RoleSchema),
  },
  { minProperties: 1, additionalProperties: false },
);

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

  /**
   * PATCH /v1/users/:id — update a team member's profile (issue #161).
   *
   * Replaces the legacy role-only `PATCH /v1/users/:id/role` with a combined
   * endpoint that accepts `{ firstName?, lastName?, role? }` (at least one
   * field). org_admin-gated and tenant-scoped via `withTenantContext`.
   *
   * Behaviour:
   *  - **DB**: only the explicitly provided fields are updated; `updatedAt`
   *    bumps unconditionally.
   *  - **Keycloak sync**: name change → `kcAdmin.updateUser(kcId, ...)`
   *    (lands on KC's `users` table; the next access token re-issues with
   *    the new `given_name` / `family_name` claims). Role change →
   *    `kcAdmin.setUserAttributes(kcId, { role: [newRole] })`, mirroring
   *    the invite-accept path. Both KC calls are best-effort relative to
   *    the DB write — but the DB write goes first so a KC blip leaves an
   *    audit row + retryable client state, not a silent missed mutation.
   *  - **Self-edit guard**: an org_admin editing their OWN row CANNOT
   *    demote themselves below `org_admin` — would lock them out of their
   *    own org. Returns 422 with code `cannot_self_demote` so the UI can
   *    show a targeted message and keep the rest of the dialog usable.
   *  - **Audit log**: `user.profile_updated` with field-level old/new diff
   *    so an admin can reconstruct exactly what changed and when.
   */
  app.patch(
    "/users/:id",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Users"],
        params: IdParams,
        body: UpdateUserBody,
        response: {
          200: DataResponse(UserResponse),
          // 422 carries the structured `cannot_self_demote` code so the
          // self-edit guard surfaces with a targeted UI message rather
          // than a generic "Forbidden". (PR-style: lock the body shape so
          // a regression doesn't quietly fall back to a plain string.)
          422: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: combined PATCH walks self-demote guard, DB diff, KC sync (name + role), and audit log — the linear flow keeps the behavioural contract obvious to a reviewer.
    async (request, reply) => {
      const orgId = request.auth?.orgId as string;
      const callerKcId = request.auth?.userId as string;
      const { id } = request.params as { id: string };
      const body = request.body as {
        firstName?: string;
        lastName?: string;
        role?: "org_admin" | "user" | "viewer";
      };

      const t = resolveTranslations(request);

      const result = await withTenantContext(orgId, async (tx) => {
        const [existing] = await tx
          .select({
            id: users.id,
            keycloakId: users.keycloakId,
            firstName: users.firstName,
            lastName: users.lastName,
            role: users.role,
          })
          .from(users)
          .where(and(eq(users.id, id), eq(users.orgId, orgId)))
          .limit(1);
        if (!existing) return { kind: "not_found" as const };

        // Self-edit lock — a caller demoting their own row below org_admin
        // would walk out of their own org. The UI hides the role Select
        // for the caller's row, but the API gate is the durable
        // enforcement (issue #161 acceptance criteria).
        const isSelf = existing.keycloakId === callerKcId;
        if (
          isSelf &&
          body.role !== undefined &&
          existing.role === "org_admin" &&
          body.role !== "org_admin"
        ) {
          return { kind: "cannot_self_demote" as const };
        }

        const patch: {
          firstName?: string;
          lastName?: string;
          role?: "org_admin" | "user" | "viewer";
          updatedAt: Date;
        } = { updatedAt: new Date() };
        if (body.firstName !== undefined) patch.firstName = body.firstName;
        if (body.lastName !== undefined) patch.lastName = body.lastName;
        if (body.role !== undefined) patch.role = body.role;

        const [updated] = await tx
          .update(users)
          .set(patch)
          .where(and(eq(users.id, id), eq(users.orgId, orgId)))
          .returning();
        if (!updated) return { kind: "not_found" as const };

        // Field-level diff — only fields the caller explicitly set are
        // recorded so the audit row stays scoped to the actual change.
        const oldValues: Record<string, string> = {};
        const newValues: Record<string, string> = {};
        if (body.firstName !== undefined && body.firstName !== existing.firstName) {
          oldValues.firstName = existing.firstName;
          newValues.firstName = body.firstName;
        }
        if (body.lastName !== undefined && body.lastName !== existing.lastName) {
          oldValues.lastName = existing.lastName;
          newValues.lastName = body.lastName;
        }
        if (body.role !== undefined && body.role !== existing.role) {
          oldValues.role = existing.role;
          newValues.role = body.role;
        }

        if (Object.keys(newValues).length > 0) {
          await tx.insert(auditLogs).values({
            orgId,
            userId: existing.id,
            action: "user.profile_updated",
            resourceType: "user",
            resourceId: existing.id,
            oldValues,
            newValues,
          });
        }

        return { kind: "ok" as const, existing, updated };
      });

      if (result.kind === "not_found") {
        return reply.status(404).send({
          type: "https://httpproblems.com/http-status/404",
          title: "Not Found",
          status: 404,
          detail: t("errors.notFound", { resource: t("resources.user") }),
        });
      }
      if (result.kind === "cannot_self_demote") {
        // Structured 422 — `code: cannot_self_demote` lets the UI render a
        // targeted message ("you can't change your own role") without
        // string-matching the human-readable detail.
        return reply.status(422).send({
          ...problemDetail(
            422,
            "Unprocessable Entity",
            "An org_admin cannot demote their own role below org_admin.",
          ),
          code: "cannot_self_demote",
        });
      }

      // Keycloak sync. We do this AFTER the DB transaction commits so a KC
      // blip can be retried by the caller without the DB and KC drifting
      // mid-transaction. Both calls are independent and best-effort
      // relative to each other — a name update succeeding while a role
      // attribute fails is recoverable on the next PATCH.
      const kcId = result.existing.keycloakId;
      if (kcId) {
        const kcAdmin = keycloakAdmin();
        // Name → KC users table (lands on `given_name` / `family_name`
        // mappers so the next refreshed token shows the updated display
        // name in the topbar).
        if (body.firstName !== undefined || body.lastName !== undefined) {
          try {
            await kcAdmin.updateUser(kcId, {
              firstName: body.firstName,
              lastName: body.lastName,
            });
          } catch (err) {
            // Don't fail the request — the DB + audit row already reflect
            // the intent. SRE can grep `user.profile_updated.kc_sync_failed`.
            request.log.warn(
              { err, kcId, userId: result.existing.id },
              "user.profile_updated.kc_sync_failed",
            );
          }
        }
        // Role → KC user attributes (matches invite-accept's setUserAttributes
        // contract so the JWT mapper emits the new `role` claim downstream).
        if (body.role !== undefined && body.role !== result.existing.role) {
          try {
            await kcAdmin.setUserAttributes(kcId, { role: [body.role] });
          } catch (err) {
            request.log.warn(
              { err, kcId, userId: result.existing.id },
              "user.profile_updated.kc_role_sync_failed",
            );
          }
        }
      }

      return reply.send({ data: result.updated });
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
