/** User routes — user profile and org-admin user management */

import { createHash } from "node:crypto";
import { type Locale, SUPPORTED_LOCALES } from "@givernance/shared/i18n";
import { USER_EVENT_TYPES } from "@givernance/shared/jobs";
import {
  auditLogs,
  currencyMetadata,
  outboxEvents,
  platformAdmins,
  tenants,
  users,
} from "@givernance/shared/schema";
import { Type } from "@sinclair/typebox";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { systemDb, withTenantContext } from "../../lib/db.js";
import { requireAuth, requireOrgAdmin } from "../../lib/guards.js";
import { resolveTranslations } from "../../lib/i18n.js";
import { keycloakAdmin } from "../../lib/keycloak-admin.js";
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
import { blocklistUser, invalidateActiveUserCache } from "../session/service.js";

const UserLocaleSchema = Type.Union(SUPPORTED_LOCALES.map((value) => Type.Literal(value)));

// ─── PATCH /v1/users/:id helpers ─────────────────────────────────────────────
//
// Pulled out of the route's `withTenantContext` callback to keep that
// callback under the cognitive-complexity threshold. Each helper is
// extract-only — same SQL, same guards, same audit semantics as the
// pre-refactor inline code. Locked by `tests/integration/user-edit.test.ts`
// (issue #161 e2e suite).

type UpdateUserBodyShape = {
  firstName?: string;
  lastName?: string;
  role?: "org_admin" | "user" | "viewer";
};

type UpdateUserExisting = {
  id: string;
  keycloakId: string | null;
  firstName: string;
  lastName: string;
  role: "org_admin" | "user" | "viewer";
};

type UpdateUserGuardResult =
  | { kind: "valid"; existing: UpdateUserExisting }
  | { kind: "not_found" }
  | { kind: "missing_keycloak_link" }
  | { kind: "cannot_self_demote" }
  | { kind: "cannot_demote_last_admin" };

/**
 * Load the target user (ADR-021 — soft-deleted rows excluded so the 404
 * path is the same as cross-tenant or non-existent), then walk the three
 * role-change guards (missing keycloak link, self-demote, last admin).
 * Returns `kind: "valid"` with the loaded row when the request can proceed.
 */
async function loadAndGuardUserUpdate(
  tx: Parameters<Parameters<typeof withTenantContext>[1]>[0],
  args: { id: string; orgId: string; body: UpdateUserBodyShape; callerKcId: string },
): Promise<UpdateUserGuardResult> {
  const { id, orgId, body, callerKcId } = args;
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
  if (!existing) return { kind: "not_found" };

  // Review PJD-3 — refuse to compare when `existing.keycloakId` is null.
  // A null id would make `null === callerKcId` always false and silently
  // skip the self-demote guard, letting an admin demote themselves through
  // the legacy-data path. Treat null as "we cannot prove this isn't the
  // caller", which is fail-closed.
  if (existing.keycloakId === null && body.role !== undefined) {
    return { kind: "missing_keycloak_link" };
  }

  // Self-edit lock — a caller demoting their own row below org_admin would
  // walk out of their own org. The UI hides the role Select for the
  // caller's row, but the API gate is the durable enforcement (issue #161).
  const isSelf = existing.keycloakId === callerKcId;
  if (
    isSelf &&
    body.role !== undefined &&
    existing.role === "org_admin" &&
    body.role !== "org_admin"
  ) {
    return { kind: "cannot_self_demote" };
  }

  // Last-admin lock-out (review S1) — refuse to demote the only remaining
  // org_admin even when the caller is a different admin. Recovery from a
  // zero-admin tenant requires super_admin intervention.
  if (body.role !== undefined && existing.role === "org_admin" && body.role !== "org_admin") {
    const countRows = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(and(eq(users.orgId, orgId), eq(users.role, "org_admin"), ne(users.id, existing.id)));
    const remainingAdmins = countRows[0]?.count ?? 0;
    if (remainingAdmins === 0) {
      return { kind: "cannot_demote_last_admin" };
    }
  }

  return { kind: "valid", existing };
}

/** Build the SET payload for `UPDATE users` from the (sparse) request body. */
function buildUserPatch(body: UpdateUserBodyShape): {
  firstName?: string;
  lastName?: string;
  role?: "org_admin" | "user" | "viewer";
  updatedAt: Date;
} {
  const patch: {
    firstName?: string;
    lastName?: string;
    role?: "org_admin" | "user" | "viewer";
    updatedAt: Date;
  } = { updatedAt: new Date() };
  if (body.firstName !== undefined) patch.firstName = body.firstName;
  if (body.lastName !== undefined) patch.lastName = body.lastName;
  if (body.role !== undefined) patch.role = body.role;
  return patch;
}

/**
 * Write the `user.profile_updated` audit row IFF the patch actually
 * changed at least one field (compared against `existing`). Review E5 —
 * `audit_logs.user_id` semantically means "who DID this" (the JWT subject),
 * not "what was changed"; the target's UUID belongs in `resource_id`.
 * `actor_id` follows the RFC 8693 convention from plugins/audit.ts (M2 fix).
 * `ip_hash` + `user_agent` mirror the auto-row the audit plugin writes for
 * every mutating request — without them, the more semantic
 * `user.profile_updated` row would silently lose forensic context.
 */
async function writeUserUpdateAuditIfChanged(
  tx: Parameters<Parameters<typeof withTenantContext>[1]>[0],
  args: {
    orgId: string;
    existing: UpdateUserExisting;
    body: UpdateUserBodyShape;
    callerKcId: string;
    actorKcId: string | null;
    ipHash: string;
    userAgent: string | undefined;
  },
): Promise<void> {
  const { orgId, existing, body, callerKcId, actorKcId, ipHash, userAgent } = args;
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
  if (Object.keys(newValues).length === 0) return;

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

/**
 * Sync a user-profile patch to Keycloak — name → users table (lands on
 * `given_name` / `family_name` mappers), role → user attributes (matches
 * invite-accept's `setUserAttributes` contract so the JWT mapper emits the
 * new `role` claim). Both calls are best-effort: failures don't fail the
 * request because the DB + audit row already reflect the intent. SRE can
 * grep `user.profile_updated.kc_sync_failed` /
 * `user.profile_updated.kc_role_sync_failed`.
 */
async function syncUserUpdateToKeycloak(args: {
  kcId: string | null;
  userId: string;
  previousRole: "org_admin" | "user" | "viewer";
  body: UpdateUserBodyShape;
  log: { warn: (obj: Record<string, unknown>, msg: string) => void };
}): Promise<void> {
  const { kcId, userId, previousRole, body, log } = args;
  if (!kcId) return;
  const kcAdmin = keycloakAdmin();

  if (body.firstName !== undefined || body.lastName !== undefined) {
    try {
      await kcAdmin.updateUser(kcId, {
        firstName: body.firstName,
        lastName: body.lastName,
      });
    } catch (err) {
      log.warn({ err, kcId, userId }, "user.profile_updated.kc_sync_failed");
    }
  }
  if (body.role !== undefined && body.role !== previousRole) {
    try {
      await kcAdmin.setUserAttributes(kcId, { role: [body.role] });
    } catch (err) {
      log.warn({ err, kcId, userId }, "user.profile_updated.kc_role_sync_failed");
    }
  }
}

/**
 * Body for `PATCH /v1/users/me` (issue #153). Setting `locale: null` clears
 * `users.locale` so the user reverts to inheriting the tenant's `default_locale`.
 * `displayCurrency` is optional — when supplied it must be an ISO 4217 3-letter
 * code that exists in `currency_metadata WHERE enabled = true`; null clears the
 * override so the user inherits the org's baseCurrency (ADR-032 §2.8, Epic #416 Task 7).
 */
const UpdateMeBody = Type.Object({
  locale: Type.Optional(Type.Union([UserLocaleSchema, Type.Null()])),
  displayCurrency: Type.Optional(
    Type.Union([Type.Null(), Type.String({ minLength: 3, maxLength: 3 })]),
  ),
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
 *
 * ADR-032 §2.8: `displayCurrency` is the user's personal display currency
 * override (NULL when they inherit the org's baseCurrency).
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
  displayCurrency: Type.Union([Type.String({ minLength: 3, maxLength: 3 }), Type.Null()]),
  orgSlug: Type.String(),
  orgName: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

type UpdateMeBodyShape = {
  locale?: "en" | "fr" | null;
  displayCurrency?: string | null;
};

type UpdateMeExisting = {
  id: string;
  locale: string | null;
  displayCurrency: string | null;
};

/**
 * Build the preferences audit diff for `PATCH /v1/users/me`.
 * Only records fields that actually changed so the audit row is minimal.
 */
function buildMePreferencesDiff(
  body: UpdateMeBodyShape,
  existing: UpdateMeExisting,
): {
  oldValues: Record<string, string | null | undefined>;
  newValues: Record<string, string | null | undefined>;
} {
  const oldValues: Record<string, string | null | undefined> = {};
  const newValues: Record<string, string | null | undefined> = {};
  if (body.locale !== undefined && body.locale !== existing.locale) {
    oldValues.locale = existing.locale;
    newValues.locale = body.locale;
  }
  if (body.displayCurrency !== undefined && body.displayCurrency !== existing.displayCurrency) {
    oldValues.displayCurrency = existing.displayCurrency;
    newValues.displayCurrency = body.displayCurrency;
  }
  return { oldValues, newValues };
}

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
      const isSuperAdmin = request.auth?.roles?.includes("super_admin") ?? false;
      // Impersonation tokens carry the TARGET as `sub`/`org_id` and the
      // operator only as `act.sub`. Even when the operator is a platform
      // admin running in delegation mode (super_admin retained in
      // `realm_access.roles`), `/v1/users/me` answers from the target's
      // perspective: the UI's job during a session is to show the org
      // and identity the operator is acting AS. Routing into the
      // `platform_admins` branch here would 404 every delegation session
      // (the target's keycloak_id has no platform_admins row), wiping
      // the org name + role on the client and silently degrading the
      // sidebar settings link. The `act` claim is the canonical
      // "this is an impersonation/delegation session" discriminator.
      const isImpersonationSession = !!request.auth?.impersonation;

      // ADR-022 — platform admins are a disjoint identity surface. They
      // have no `users` row and no app-DB tenant. Resolve via
      // `platform_admins` and synthesise the tenant-shaped fields from
      // the JWT's `org_id` claim (which mirrors the Keycloak "platform"
      // Organization id) so the existing MeProfile contract on the
      // client stays a single shape.
      if (isSuperAdmin && !isImpersonationSession) {
        const [admin] = await systemDb
          .select({
            id: platformAdmins.id,
            keycloakId: platformAdmins.keycloakId,
            email: platformAdmins.email,
            firstName: platformAdmins.firstName,
            lastName: platformAdmins.lastName,
            locale: platformAdmins.locale,
            createdAt: platformAdmins.createdAt,
            updatedAt: platformAdmins.updatedAt,
          })
          .from(platformAdmins)
          .where(and(eq(platformAdmins.keycloakId, userId), isNull(platformAdmins.deletedAt)))
          .limit(1);

        if (!admin) {
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
            id: admin.id,
            orgId,
            keycloakId: admin.keycloakId,
            email: admin.email,
            firstName: admin.firstName,
            lastName: admin.lastName,
            role: "super_admin",
            firstAdmin: false,
            provisionalUntil: null,
            locale: admin.locale as "en" | "fr" | null,
            displayCurrency: null,
            tenantDefaultLocale: "en" as const,
            orgSlug: "platform",
            orgName: "Givernance Platform",
            createdAt: admin.createdAt.toISOString(),
            updatedAt: admin.updatedAt.toISOString(),
          },
        });
      }

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
            displayCurrency: users.displayCurrency,
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
      const body = request.body as UpdateMeBodyShape;
      const isSuperAdmin = request.auth?.roles?.includes("super_admin") ?? false;
      const isImpersonationSession = !!request.auth?.impersonation;

      // ADR-022 — super-admins outside an impersonation session live in
      // `platform_admins`, not `users`. Mirror the GET branch: read +
      // update + audit through the platform-side table instead of the
      // tenant-scoped `users` row (which doesn't exist for them and
      // would always 404). Same shape returned to the client so the
      // profile form's re-base step works uniformly.
      if (isSuperAdmin && !isImpersonationSession) {
        const [existing] = await systemDb
          .select({ id: platformAdmins.id, locale: platformAdmins.locale })
          .from(platformAdmins)
          .where(and(eq(platformAdmins.keycloakId, userId), isNull(platformAdmins.deletedAt)))
          .limit(1);

        if (!existing) {
          const t = resolveTranslations(request);
          return reply.status(404).send({
            type: "https://httpproblems.com/http-status/404",
            title: "Not Found",
            status: 404,
            detail: t("errors.notFound", { resource: t("resources.user") }),
          });
        }

        const [updated] = await systemDb
          .update(platformAdmins)
          .set({ locale: body.locale, updatedAt: new Date() })
          .where(eq(platformAdmins.id, existing.id))
          .returning({
            id: platformAdmins.id,
            keycloakId: platformAdmins.keycloakId,
            email: platformAdmins.email,
            firstName: platformAdmins.firstName,
            lastName: platformAdmins.lastName,
            locale: platformAdmins.locale,
            createdAt: platformAdmins.createdAt,
            updatedAt: platformAdmins.updatedAt,
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

        // Audit log on the platform sentinel tenant — same pattern as
        // the super-admin finance routes (resource_type carries the
        // platform-side table name so a forensic timeline distinguishes
        // tenant-user preferences from super-admin preferences).
        const [platformTenant] = await systemDb
          .select({ id: tenants.id, defaultLocale: tenants.defaultLocale })
          .from(tenants)
          .where(eq(tenants.slug, "__platform__"))
          .limit(1);
        if (platformTenant) {
          try {
            await systemDb.insert(auditLogs).values({
              orgId: platformTenant.id,
              userId: null,
              actorId: userId,
              action: "platform_admin.preferences_updated",
              resourceType: "platform_admin",
              resourceId: existing.id,
              oldValues: { locale: existing.locale },
              newValues: { locale: body.locale },
            });
          } catch (err) {
            request.log.error(
              { err, audit: "INSERT_FAILED" },
              "CRITICAL: platform-admin preferences audit insert failed",
            );
          }
        }

        return reply.send({
          data: {
            id: updated.id,
            orgId,
            keycloakId: updated.keycloakId,
            email: updated.email,
            firstName: updated.firstName,
            lastName: updated.lastName,
            role: "super_admin" as const,
            firstAdmin: false,
            provisionalUntil: null,
            locale: updated.locale as "en" | "fr" | null,
            displayCurrency: null,
            tenantDefaultLocale: "en" as const,
            orgSlug: "platform",
            orgName: "Givernance Platform",
            createdAt: updated.createdAt.toISOString(),
            updatedAt: updated.updatedAt.toISOString(),
          },
        });
      }

      // Validate displayCurrency against currency_metadata WHERE enabled = true
      // (ADR-032 §2.8). currency_metadata has no RLS so we use systemDb.
      if (body.displayCurrency !== undefined && body.displayCurrency !== null) {
        const [currRow] = await systemDb
          .select({ code: currencyMetadata.code })
          .from(currencyMetadata)
          .where(
            and(
              eq(currencyMetadata.code, body.displayCurrency),
              eq(currencyMetadata.enabled, true),
            ),
          )
          .limit(1);
        if (!currRow) {
          return reply.status(422).send({
            type: "https://httpproblems.com/http-status/422",
            title: "Unprocessable Entity",
            status: 422,
            detail: "Currency not supported or not enabled.",
          });
        }
      }

      const result = await withTenantContext(orgId, async (tx) => {
        // Read the existing preferences so the audit `oldValues` carries the
        // pre-update values. The same SELECT also resolves the application
        // user id for the audit row's `userId` column.
        const [existing] = await tx
          .select({ id: users.id, locale: users.locale, displayCurrency: users.displayCurrency })
          .from(users)
          .where(and(eq(users.keycloakId, userId), eq(users.orgId, orgId), isNull(users.deletedAt)))
          .limit(1);
        if (!existing) return null;

        // Build the sparse patch — only update fields explicitly provided in
        // the body so callers can patch locale without touching displayCurrency
        // and vice versa.
        const patch: { updatedAt: Date; locale?: Locale | null; displayCurrency?: string | null } =
          { updatedAt: new Date() };
        if (body.locale !== undefined) patch.locale = body.locale as Locale | null;
        if (body.displayCurrency !== undefined) patch.displayCurrency = body.displayCurrency;

        const [updated] = await tx
          .update(users)
          .set(patch)
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
            displayCurrency: users.displayCurrency,
            createdAt: users.createdAt,
            updatedAt: users.updatedAt,
          });
        if (!updated) return null;

        // Audit diff — only record fields that actually changed.
        const { oldValues, newValues } = buildMePreferencesDiff(body, existing);
        if (Object.keys(newValues).length > 0) {
          await tx.insert(auditLogs).values({
            orgId,
            userId: existing.id,
            action: "user.preferences_updated",
            resourceType: "user",
            resourceId: existing.id,
            oldValues,
            newValues,
          });
        }

        const [tenantRow] = await tx
          .select({ slug: tenants.slug, name: tenants.name, defaultLocale: tenants.defaultLocale })
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
        const guard = await loadAndGuardUserUpdate(tx, { id, orgId, body, callerKcId });
        if (guard.kind !== "valid") return guard;

        const [updated] = await tx
          .update(users)
          .set(buildUserPatch(body))
          .where(and(eq(users.id, id), eq(users.orgId, orgId)))
          .returning();
        if (!updated) return { kind: "not_found" as const };

        await writeUserUpdateAuditIfChanged(tx, {
          orgId,
          existing: guard.existing,
          body,
          callerKcId,
          actorKcId,
          ipHash,
          userAgent,
        });

        return { kind: "ok" as const, existing: guard.existing, updated };
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

      // Keycloak sync runs AFTER the DB transaction commits — a KC blip
      // can be retried by the caller without the DB and KC drifting
      // mid-transaction.
      await syncUserUpdateToKeycloak({
        kcId: result.existing.keycloakId,
        userId: result.existing.id,
        previousRole: result.existing.role,
        body,
        log: request.log,
      });

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
          // Issue #430 — explicit org filter for defence in depth.
          const [row] = await tx
            .select()
            .from(users)
            .where(and(eq(users.id, id), eq(users.orgId, orgId)))
            .limit(1);
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

        // GDPR erasure cascade (issue #439). Surveys carry the user as
        // a FK on `survey_invitations.user_id` (ON DELETE SET NULL).
        // The cascade processor NULLs every pending invitation pointer
        // and emits one audit_logs row per affected invitation so the
        // immutable trail records the erasure path. Emitting from
        // inside the soft-delete tx keeps the (row mutation, outbox
        // emit) pair atomic — a relay redelivery and a tx rollback
        // can never disagree about whether the cascade is owed.
        await tx.insert(outboxEvents).values({
          tenantId: orgId,
          type: USER_EVENT_TYPES.SOFT_DELETED,
          payload: { userId: updated.id, orgId },
        });

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
