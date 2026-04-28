/** User routes — user profile and org-admin user management */

import { createHash } from "node:crypto";
import { SUPPORTED_LOCALES } from "@givernance/shared/i18n";
import { auditLogs, outboxEvents, tenants, users } from "@givernance/shared/schema";
import { Type } from "@sinclair/typebox";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { withTenantContext } from "../../lib/db.js";
import { requireAuth, requireOrgAdmin } from "../../lib/guards.js";
import { resolveTranslations } from "../../lib/i18n.js";
import { keycloakAdmin } from "../../lib/keycloak-admin.js";
import { blocklistUser, invalidateActiveUserCache } from "../session/service.js";
import {
  DataArrayResponse,
  DataResponse,
  ErrorResponses,
  IdParams,
  PaginationQuery,
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
          .where(
            and(
              eq(users.keycloakId, userId),
              eq(users.orgId, orgId),
              // ADR-021 — soft-deleted users are invisible to /me even
              // if their JWT still validates (the auth plugin's user
              // blocklist also catches this; this is the belt to the
              // suspenders).
              isNull(users.deletedAt),
            ),
          );
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
          .where(and(eq(users.keycloakId, userId), eq(users.orgId, orgId), isNull(users.deletedAt)))
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

  /**
   * GET /v1/users — paginated list of users in the tenant (org_admin only).
   *
   * Review PJD-6: previously returned the full list unconditionally, which
   * scales badly for an org with hundreds of staff. Now uses the standard
   * `page` / `perPage` query params (max 100/page) and returns the
   * `DataArrayResponse` envelope with pagination metadata.
   */
  app.get(
    "/users",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Users"],
        querystring: PaginationQuery,
        response: { 200: DataArrayResponse(UserResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId as string;
      const query = request.query as { page?: number; perPage?: number };
      const page = query.page ?? 1;
      const perPage = query.perPage ?? 20;
      const offset = (page - 1) * perPage;

      const { rows, total } = await withTenantContext(orgId, async (tx) => {
        // ADR-021 — soft-deleted rows are excluded from the members list.
        const activeFilter = and(eq(users.orgId, orgId), isNull(users.deletedAt));
        const countRows = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(users)
          .where(activeFilter);
        const countResult = countRows[0]?.total ?? 0;
        const data = await tx
          .select()
          .from(users)
          .where(activeFilter)
          .orderBy(users.firstName, users.lastName, users.email)
          .limit(perPage)
          .offset(offset);
        return { rows: data, total: countResult ?? 0 };
      });

      return reply.send({
        data: rows,
        pagination: {
          page,
          perPage,
          total,
          totalPages: Math.max(1, Math.ceil(total / perPage)),
        },
      });
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
      // Impersonation: when an admin acts on behalf of another user via
      // the RFC 8693 `act` claim (issue #24, ADR-016), the JWT carries
      // `{ sub: <subject>, act: { sub: <admin> } }`. The audit row's
      // `userId` is always the subject; `actorId` is the impersonating
      // admin (NULL under normal auth where they're the same principal,
      // matching the convention in plugins/audit.ts M2 fix).
      const actorKcId = request.auth?.act?.sub ?? null;
      // Mirror the audit plugin's `ip_hash` / `user_agent` capture so the
      // domain-specific audit row is self-contained — without these, the
      // row is missing forensic context that the plugin's auto-row has but
      // the more semantic `user.profile_updated` row doesn't.
      const ipHash = createHash("sha256").update(request.ip).digest("hex").slice(0, 16);
      const userAgentHeader = request.headers["user-agent"];
      const userAgent = typeof userAgentHeader === "string" ? userAgentHeader : undefined;
      const { id } = request.params as { id: string };
      const body = request.body as {
        firstName?: string;
        lastName?: string;
        role?: "org_admin" | "user" | "viewer";
      };

      const t = resolveTranslations(request);

      const result = await withTenantContext(orgId, async (tx) => {
        // ADR-021 — soft-deleted users are not editable. The 404 path
        // is the same as cross-tenant or non-existent (no enumeration).
        const [existing] = await tx
          .select({
            id: users.id,
            keycloakId: users.keycloakId,
            firstName: users.firstName,
            lastName: users.lastName,
            role: users.role,
          })
          .from(users)
          .where(and(eq(users.id, id), eq(users.orgId, orgId), isNull(users.deletedAt)))
          .limit(1);
        if (!existing) return { kind: "not_found" as const };

        // Self-edit lock — a caller demoting their own row below org_admin
        // would walk out of their own org. The UI hides the role Select
        // for the caller's row, but the API gate is the durable
        // enforcement (issue #161 acceptance criteria).
        //
        // Review PJD-3 — refuse to compare when `existing.keycloakId` is
        // null. A null id would make `null === callerKcId` always false
        // and silently skip the self-demote guard, letting an admin demote
        // themselves through the legacy-data path. Treat null as "we
        // cannot prove this isn't the caller", which is fail-closed.
        if (existing.keycloakId === null && body.role !== undefined) {
          return { kind: "missing_keycloak_link" as const };
        }
        const isSelf = existing.keycloakId === callerKcId;
        if (
          isSelf &&
          body.role !== undefined &&
          existing.role === "org_admin" &&
          body.role !== "org_admin"
        ) {
          return { kind: "cannot_self_demote" as const };
        }

        // Last-admin lock-out guard (review S1) — even when the caller is a
        // DIFFERENT admin, demoting the only remaining `org_admin` (or this
        // admin if they happen to be the only one and another admin sent
        // the request) leaves the tenant with zero administrators. Recovery
        // would require super_admin intervention or DB surgery, so refuse
        // with a structured 422 the UI can map to a targeted message.
        if (body.role !== undefined && existing.role === "org_admin" && body.role !== "org_admin") {
          const countRows = await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(users)
            .where(
              and(eq(users.orgId, orgId), eq(users.role, "org_admin"), ne(users.id, existing.id)),
            );
          const remainingAdmins = countRows[0]?.count ?? 0;
          if (remainingAdmins === 0) {
            return { kind: "cannot_demote_last_admin" as const };
          }
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
          // Review E5 — `audit_logs.user_id` semantically means "who DID
          // this" (the JWT subject), not "what was changed". The target's
          // UUID belongs in `resource_id`. `actor_id` follows the
          // RFC 8693 convention from plugins/audit.ts (M2 fix): NULL under
          // normal auth, populated with the impersonating admin's sub
          // when the JWT carries an `act` claim. `ip_hash` + `user_agent`
          // mirror the auto-row the audit plugin writes for every
          // mutating request — without them, the more semantic
          // `user.profile_updated` row would silently lose forensic
          // context the auto-row has.
          await tx.insert(auditLogs).values({
            orgId,
            userId: callerKcId,
            actorId: actorKcId,
            action: "user.profile_updated",
            resourceType: "user",
            resourceId: existing.id,
            oldValues,
            newValues,
            ipHash,
            userAgent,
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
          errorCode: "cannot_self_demote",
        });
      }
      if (result.kind === "missing_keycloak_link") {
        // Review PJD-3 — fail-closed when the target row predates the
        // Keycloak link (legacy import). Surface a discriminator distinct
        // from the cross-tenant 404 so the admin knows to repair the row
        // (e.g. via tenant-admin tooling) rather than thinking the user
        // doesn't exist.
        return reply.status(422).send({
          ...problemDetail(
            422,
            "Unprocessable Entity",
            "Cannot change role: this user has no Keycloak link. Contact support to repair the account.",
          ),
          errorCode: "missing_keycloak_link",
        });
      }
      if (result.kind === "cannot_demote_last_admin") {
        // Structured 422 — recovery from a zero-admin tenant requires
        // super_admin intervention (review S1). Surface a discriminator
        // distinct from `cannot_self_demote` so the UI can show "demote
        // someone after promoting another admin" rather than "you can't
        // change your own role".
        return reply.status(422).send({
          ...problemDetail(
            422,
            "Unprocessable Entity",
            "Cannot demote the last org_admin in this tenant — promote another admin first.",
          ),
          errorCode: "cannot_demote_last_admin",
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

  /**
   * DELETE /v1/users/:id — remove user from tenant (org_admin only).
   *
   * Per ADR-021 ("User Lifecycle"):
   *  - **App**: soft-delete (`deleted_at = now()`, `keycloak_id = NULL`).
   *    The row is preserved so audit FKs and history stay intact; listing
   *    endpoints filter `deleted_at IS NULL` so the user disappears from
   *    the members table immediately.
   *  - **Keycloak**: delete the realm user. Frees the email for re-invite
   *    (otherwise `createUser` 409s on accept) and drops their refresh
   *    tokens.
   *  - **Auth boundary**: blocklist the user's Keycloak `sub` so
   *    already-issued access tokens are rejected at the auth plugin
   *    layer until they expire naturally (closes the post-delete
   *    access window — see ADR-021 "Auth boundary"). Active-row cache
   *    invalidation is the belt to the blocklist's suspenders.
   *  - **Already-deleted is idempotent**: a request for a soft-deleted
   *    row returns 200 with the existing soft-deleted state (re-running
   *    cleanup is safe).
   */
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

      const result = await withTenantContext(orgId, async (tx) => {
        // Capture keycloakId before the soft-delete so we can fire KC
        // deleteUser + blocklist after the tx commits. Selecting the
        // current row (including soft-deleted) lets us short-circuit
        // already-deleted as 200 OK.
        const [existing] = await tx
          .select({
            id: users.id,
            keycloakId: users.keycloakId,
            deletedAt: users.deletedAt,
          })
          .from(users)
          .where(and(eq(users.id, id), eq(users.orgId, orgId)))
          .limit(1);
        if (!existing) return { kind: "not_found" as const };

        if (existing.deletedAt) {
          // Idempotent: already soft-deleted, return the row as-is. KC
          // cleanup may have failed previously; the post-commit hooks
          // below run again to reconverge.
          const [row] = await tx.select().from(users).where(eq(users.id, id)).limit(1);
          return {
            kind: "already_soft_deleted" as const,
            keycloakId: existing.keycloakId,
            row,
          };
        }

        // Soft-delete: clear keycloakId so any future query treating it
        // as a foreign key into KC misses (the realm user is about to
        // be deleted). Audit row picked up by the audit plugin.
        const [updated] = await tx
          .update(users)
          .set({ deletedAt: new Date(), keycloakId: null, updatedAt: new Date() })
          .where(and(eq(users.id, id), eq(users.orgId, orgId)))
          .returning();
        if (!updated) return { kind: "not_found" as const };

        return {
          kind: "soft_deleted" as const,
          keycloakId: existing.keycloakId,
          row: updated,
        };
      });

      if (result.kind === "not_found") {
        const t = resolveTranslations(request);
        return reply.status(404).send({
          type: "https://httpproblems.com/http-status/404",
          title: "Not Found",
          status: 404,
          detail: t("errors.notFound", { resource: t("resources.user") }),
        });
      }

      // Post-commit reconciliation with KC + auth boundary. Best-effort:
      // a KC blip leaves the row soft-deleted (which is correct from the
      // app's perspective) and the operator can retry the DELETE — the
      // idempotent branch above re-runs the cleanup. Failures are logged
      // at warn so SRE can grep `user.removed.kc_sync_failed`.
      const { keycloakId } = result;
      if (keycloakId) {
        try {
          await keycloakAdmin().deleteUser(keycloakId);
        } catch (err) {
          request.log.warn({ err, keycloakId, userId: id }, "user.removed.kc_sync_failed");
        }
        // Blocklist the sub regardless of KC delete outcome — closes the
        // access-token window even if the KC user lingers. TTL covers
        // the realm's max access-token lifetime; expiring this entry
        // early is fine because the KC user is also gone (or being
        // retried) so fresh tokens won't mint.
        try {
          await blocklistUser(keycloakId);
        } catch (err) {
          request.log.warn({ err, keycloakId }, "user.removed.blocklist_failed");
        }
        // Drop the active-row cache so the next request observes the
        // soft-delete without waiting for the 30s TTL.
        await invalidateActiveUserCache(keycloakId, orgId);
      }

      return reply.status(200).send({ data: result.row });
    },
  );
}
