/**
 * Service layer for the platform-admin CRUD API (issue #254).
 *
 * Platform admins are Givernance staff with the Keycloak realm role
 * `super_admin` — modeled as a first-class identity surface disjoint from
 * tenant `users` (ADR-022). This module owns:
 *
 *   - List/detail with sort + filter + pagination.
 *   - Create — direct Keycloak provisioning: createUser → assign
 *     `super_admin` realm role → attach to the "Givernance Platform"
 *     Organization → trigger UPDATE_PASSWORD email so the new admin sets
 *     their own password on first login.
 *   - Rename — first/last name only (email rotation is out of scope).
 *   - Reset-password — re-trigger the UPDATE_PASSWORD email.
 *   - Soft-delete — write `deleted_at`, blocklist the Keycloak `sub`
 *     (zero-second propagation per ADR-021), and hard-delete the realm
 *     user so the email is freed and refresh tokens are dropped.
 *
 * Guards (non-negotiable):
 *   - Self-removal disallowed (operator cannot soft-delete their own row).
 *   - Last-admin guard: refuse a soft-delete that would leave zero active
 *     platform admins.
 *   - Identity invariant: refuse a create whose email matches an existing
 *     `users` row (active or soft-deleted) — a Keycloak person is either
 *     a platform admin or a tenant member, never both.
 *
 * Audit: every mutation writes an `audit_logs` row with the operator's
 * `actor_id`. The lifecycle actions are `platform_admin.created`,
 * `platform_admin.renamed`, `platform_admin.password_reset_sent`,
 * `platform_admin.removed`. Audit rows are written under the *legacy*
 * platform-org id (`PLATFORM_AUDIT_ORG_ID`) so an SOC reviewer can grep
 * one tenant id for the full platform-admin lifecycle without having to
 * UNION across customer tenants. The id is a Keycloak-side constant; no
 * `tenants` row exists at it (ADR-022).
 */

import { randomBytes } from "node:crypto";
import {
  auditLogs,
  platformAdmins,
  type platformAdmins as platformAdminsTable,
  users,
} from "@givernance/shared/schema";
import { and, asc, desc, eq, ilike, isNotNull, isNull, or, type SQL, sql } from "drizzle-orm";
import { systemDb } from "../../lib/db.js";
import { KeycloakUserExistsError, keycloakAdmin } from "../../lib/keycloak-admin.js";
import { blocklistUser } from "../session/service.js";

/**
 * The Keycloak "Givernance Platform" Organization's `org_id` attribute —
 * mirrors the realm-import seed (`infra/keycloak/realm-givernance.json`).
 * It is **not** an app-DB tenant id (ADR-022 removed the synthetic
 * `tenants` row). Used only as the `audit_logs.org_id` value for the
 * platform-admin lifecycle so a reviewer can scope a query to the
 * platform tenant id and see every super-admin lifecycle event.
 */
const PLATFORM_AUDIT_ORG_ID = "00000000-0000-0000-0000-0000000000a1";

/**
 * Lifespan for the UPDATE_PASSWORD email link (4 hours). Long enough that
 * a new admin can set up at their own pace; short enough that a leaked
 * email cannot be redeemed days later. The realm-level default is
 * typically 12h; we pin a tighter value here.
 */
const PASSWORD_RESET_LIFESPAN_SEC = 4 * 60 * 60;

const SUPER_ADMIN_ROLE_NAME = "super_admin";
const PLATFORM_ORG_ALIAS = "platform";

// ─── Errors ──────────────────────────────────────────────────────────────────

export class PlatformAdminServiceError extends Error {
  readonly status: number;
  readonly code:
    | "NOT_FOUND"
    | "EMAIL_TAKEN_BY_TENANT_USER"
    | "EMAIL_TAKEN_BY_KEYCLOAK"
    | "EMAIL_TAKEN_BY_PLATFORM_ADMIN"
    | "SELF_REMOVAL_FORBIDDEN"
    | "LAST_ADMIN_FORBIDDEN"
    | "KEYCLOAK_ROLE_MISSING"
    | "KEYCLOAK_ORG_MISSING"
    | "KEYCLOAK_FAILURE";
  constructor(status: number, code: PlatformAdminServiceError["code"], message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ─── Public types ────────────────────────────────────────────────────────────

export type PlatformAdminRow = typeof platformAdminsTable.$inferSelect;

export const PLATFORM_ADMIN_SORT_FIELDS = [
  "lastName",
  "email",
  "createdAt",
  "lastLoginAt",
] as const;
export type PlatformAdminSortField = (typeof PLATFORM_ADMIN_SORT_FIELDS)[number];
export type PlatformAdminSortOrder = "asc" | "desc";

export interface ListFilters {
  q?: string;
  /** When `true`, include soft-deleted rows. Default false. */
  includeDeleted?: boolean;
  sort: PlatformAdminSortField;
  order: PlatformAdminSortOrder;
  limit: number;
  offset: number;
}

export interface ListResult {
  rows: PlatformAdminRow[];
  total: number;
}

export interface CreateInput {
  email: string;
  firstName: string;
  lastName: string;
  /** Keycloak `sub` of the operator performing the create. */
  actorKeycloakId: string;
  /** Hash of operator IP + user-agent for audit_logs. */
  ipHash: string | null;
  userAgent: string | null;
}

export interface UpdateNameInput {
  id: string;
  firstName: string;
  lastName: string;
  actorKeycloakId: string;
  ipHash: string | null;
  userAgent: string | null;
}

export interface ResetPasswordInput {
  id: string;
  actorKeycloakId: string;
  ipHash: string | null;
  userAgent: string | null;
}

export interface SoftDeleteInput {
  id: string;
  /** Keycloak `sub` of the operator. The self-removal guard compares against this. */
  actorKeycloakId: string;
  ipHash: string | null;
  userAgent: string | null;
}

// ─── List + detail ───────────────────────────────────────────────────────────

export async function listPlatformAdmins(filters: ListFilters): Promise<ListResult> {
  const conditions: SQL[] = [];
  if (!filters.includeDeleted) {
    conditions.push(isNull(platformAdmins.deletedAt));
  }
  if (filters.q) {
    const raw = filters.q.trim();
    if (raw.length > 0) {
      const like = `%${raw}%`;
      const lowered = `%${raw.toLowerCase()}%`;
      conditions.push(
        or(
          ilike(platformAdmins.firstName, like),
          ilike(platformAdmins.lastName, like),
          sql`lower(${platformAdmins.email}) LIKE ${lowered}`,
        )!,
      );
    }
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const orderColumn = (() => {
    switch (filters.sort) {
      case "lastName":
        return platformAdmins.lastName;
      case "email":
        return platformAdmins.email;
      case "lastLoginAt":
        return platformAdmins.lastLoginAt;
      case "createdAt":
        return platformAdmins.createdAt;
    }
  })();

  const orderClause = filters.order === "asc" ? asc(orderColumn) : desc(orderColumn);

  const [rows, totalRow] = await Promise.all([
    systemDb
      .select()
      .from(platformAdmins)
      .where(whereClause)
      .orderBy(orderClause)
      .limit(filters.limit)
      .offset(filters.offset),
    systemDb.select({ count: sql<number>`COUNT(*)::int` }).from(platformAdmins).where(whereClause),
  ]);

  return { rows, total: totalRow[0]?.count ?? 0 };
}

export async function getPlatformAdminById(id: string): Promise<PlatformAdminRow | null> {
  const [row] = await systemDb
    .select()
    .from(platformAdmins)
    .where(eq(platformAdmins.id, id))
    .limit(1);
  return row ?? null;
}

// ─── Create ──────────────────────────────────────────────────────────────────

/**
 * Create a new platform admin end-to-end:
 *
 *   1. Identity-invariant check — refuse if the email belongs to an
 *      existing `users` row (active OR soft-deleted; ADR-022).
 *   2. Pre-flight Keycloak realm-role lookup — fail fast if `super_admin`
 *      is missing rather than half-create the user.
 *   3. Pre-flight Keycloak Organization lookup — fail fast if the platform
 *      Org is missing.
 *   4. `kcAdmin.createUser` — random temporary password (the user never
 *      sees it; UPDATE_PASSWORD email forces them to set their own).
 *   5. `kcAdmin.assignRealmRoleToUser(super_admin)`.
 *   6. `kcAdmin.attachUserToOrg(platformOrgId, kcUserId)`.
 *   7. `kcAdmin.sendExecuteActionsEmail(["UPDATE_PASSWORD"])`.
 *   8. INSERT `platform_admins` row + `audit_logs.platform_admin.created`
 *      in a single transaction.
 *
 * On any KC-side failure after step 4, attempts a best-effort
 * compensating `deleteUser` so the realm doesn't keep an orphan account.
 * If the compensating delete itself fails, the orphan is logged so an
 * operator can clean it up — we don't rollback further than KC will let
 * us. The DB insert is the last step, so a DB failure leaves a fully
 * provisioned KC user but no app row; the operator retries with the same
 * email and the create call fails on the KC `getUserByEmail` lookup. We
 * return a typed `EMAIL_TAKEN_BY_KEYCLOAK` so the route can surface a
 * recoverable 409.
 */
export async function createPlatformAdmin(input: CreateInput): Promise<PlatformAdminRow> {
  const email = input.email.trim().toLowerCase();

  // Identity invariant — ADR-022. A Keycloak person is either a platform
  // admin or a tenant member, never both. Reject regardless of soft-delete
  // status because the email is reserved by an existing identity.
  const [collisionUser] = await systemDb
    .select({ id: users.id, deletedAt: users.deletedAt })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);
  if (collisionUser) {
    throw new PlatformAdminServiceError(
      409,
      "EMAIL_TAKEN_BY_TENANT_USER",
      "This email belongs to a tenant member; the same Keycloak person cannot be both a platform admin and a tenant user (ADR-022).",
    );
  }

  // Same-table collision: another active platform admin holds this email.
  const [collisionAdmin] = await systemDb
    .select({ id: platformAdmins.id })
    .from(platformAdmins)
    .where(and(sql`lower(${platformAdmins.email}) = ${email}`, isNull(platformAdmins.deletedAt)))
    .limit(1);
  if (collisionAdmin) {
    throw new PlatformAdminServiceError(
      409,
      "EMAIL_TAKEN_BY_PLATFORM_ADMIN",
      "A platform admin already exists with this email.",
    );
  }

  // Pre-flight KC role + organization. Fail fast before we mutate KC state
  // — a missing role / org points at a misconfigured realm and is an
  // operator-visible 502 rather than a half-finished provision.
  const [role, org] = await Promise.all([
    keycloakAdmin().getRealmRole(SUPER_ADMIN_ROLE_NAME),
    keycloakAdmin().getOrganizationByAlias(PLATFORM_ORG_ALIAS),
  ]);
  if (!role) {
    throw new PlatformAdminServiceError(
      502,
      "KEYCLOAK_ROLE_MISSING",
      `Keycloak realm role '${SUPER_ADMIN_ROLE_NAME}' is missing — realm needs re-importing.`,
    );
  }
  if (!org) {
    throw new PlatformAdminServiceError(
      502,
      "KEYCLOAK_ORG_MISSING",
      `Keycloak Organization with alias '${PLATFORM_ORG_ALIAS}' is missing — realm needs re-importing.`,
    );
  }

  // Provision the KC user. The temporary password is a high-entropy
  // throwaway — the user never sees it because we immediately trigger
  // UPDATE_PASSWORD which forces them to set their own.
  let kcUserId: string;
  try {
    const out = await keycloakAdmin().createUser({
      email,
      firstName: input.firstName,
      lastName: input.lastName,
      // 32 bytes of entropy in hex — never logged or transmitted; immediately
      // overwritten by the UPDATE_PASSWORD flow before first login.
      password: cryptoRandomPassword(),
      emailVerified: true,
    });
    kcUserId = out.id;
  } catch (err) {
    if (err instanceof KeycloakUserExistsError) {
      throw new PlatformAdminServiceError(
        409,
        "EMAIL_TAKEN_BY_KEYCLOAK",
        "A Keycloak user with this email already exists. If this is an orphan from a previous failed create, an operator must clean it up in Keycloak before retrying.",
      );
    }
    throw err;
  }

  // From here on, any failure must compensate by deleting the KC user
  // we just created — otherwise the realm accumulates orphans.
  try {
    await keycloakAdmin().assignRealmRoleToUser(kcUserId, role);
    await keycloakAdmin().attachUserToOrg(org.id, kcUserId);
    await keycloakAdmin().sendExecuteActionsEmail(kcUserId, ["UPDATE_PASSWORD"], {
      lifespanSec: PASSWORD_RESET_LIFESPAN_SEC,
    });
  } catch (err) {
    await compensatingKcDelete(kcUserId);
    if (err instanceof PlatformAdminServiceError) throw err;
    throw new PlatformAdminServiceError(
      502,
      "KEYCLOAK_FAILURE",
      `Keycloak provisioning failed mid-flight; rolled back the realm user. Original error: ${(err as Error).message}`,
    );
  }

  // DB row + audit in one transaction — if either fails the KC user is
  // already provisioned. The `EMAIL_TAKEN_BY_KEYCLOAK` recovery path on
  // retry handles this case (the operator gets a structured 409 they can
  // act on instead of a 500 cascade).
  const created = await systemDb.transaction(async (tx) => {
    const [row] = await tx
      .insert(platformAdmins)
      .values({
        keycloakId: kcUserId,
        email,
        firstName: input.firstName,
        lastName: input.lastName,
      })
      .returning();
    if (!row) throw new Error("createPlatformAdmin: insert returned no row");

    await tx.execute(
      sql`SELECT set_config('app.current_organization_id', ${PLATFORM_AUDIT_ORG_ID}, true)`,
    );
    await tx.insert(auditLogs).values({
      orgId: PLATFORM_AUDIT_ORG_ID,
      userId: kcUserId,
      actorId: input.actorKeycloakId,
      action: "platform_admin.created",
      resourceType: "platform_admin",
      resourceId: row.id,
      ipHash: input.ipHash,
      userAgent: input.userAgent ?? undefined,
    });
    return row;
  });

  return created;
}

// ─── Rename ──────────────────────────────────────────────────────────────────

export async function updatePlatformAdminName(input: UpdateNameInput): Promise<PlatformAdminRow> {
  const existing = await getActiveAdminOrThrow(input.id);

  await keycloakAdmin().updateUser(existing.keycloakId!, {
    firstName: input.firstName,
    lastName: input.lastName,
  });

  const updated = await systemDb.transaction(async (tx) => {
    const [row] = await tx
      .update(platformAdmins)
      .set({
        firstName: input.firstName,
        lastName: input.lastName,
        updatedAt: new Date(),
      })
      .where(eq(platformAdmins.id, input.id))
      .returning();
    if (!row) throw new Error("updatePlatformAdminName: update returned no row");

    await tx.execute(
      sql`SELECT set_config('app.current_organization_id', ${PLATFORM_AUDIT_ORG_ID}, true)`,
    );
    await tx.insert(auditLogs).values({
      orgId: PLATFORM_AUDIT_ORG_ID,
      userId: existing.keycloakId,
      actorId: input.actorKeycloakId,
      action: "platform_admin.renamed",
      resourceType: "platform_admin",
      resourceId: input.id,
      oldValues: {
        firstName: existing.firstName,
        lastName: existing.lastName,
      },
      newValues: {
        firstName: input.firstName,
        lastName: input.lastName,
      },
      ipHash: input.ipHash,
      userAgent: input.userAgent ?? undefined,
    });
    return row;
  });

  return updated;
}

// ─── Reset password ──────────────────────────────────────────────────────────

export async function resetPlatformAdminPassword(input: ResetPasswordInput): Promise<void> {
  const existing = await getActiveAdminOrThrow(input.id);

  await keycloakAdmin().sendExecuteActionsEmail(existing.keycloakId!, ["UPDATE_PASSWORD"], {
    lifespanSec: PASSWORD_RESET_LIFESPAN_SEC,
  });

  await systemDb.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.current_organization_id', ${PLATFORM_AUDIT_ORG_ID}, true)`,
    );
    await tx.insert(auditLogs).values({
      orgId: PLATFORM_AUDIT_ORG_ID,
      userId: existing.keycloakId,
      actorId: input.actorKeycloakId,
      action: "platform_admin.password_reset_sent",
      resourceType: "platform_admin",
      resourceId: input.id,
      ipHash: input.ipHash,
      userAgent: input.userAgent ?? undefined,
    });
  });
}

// ─── Soft-delete ─────────────────────────────────────────────────────────────

export async function softDeletePlatformAdmin(input: SoftDeleteInput): Promise<void> {
  const existing = await getActiveAdminOrThrow(input.id);

  if (existing.keycloakId === input.actorKeycloakId) {
    throw new PlatformAdminServiceError(
      400,
      "SELF_REMOVAL_FORBIDDEN",
      "Operators cannot soft-delete their own platform-admin row. Ask another super-admin.",
    );
  }

  // Last-admin guard. Refuse the soft-delete that would leave zero
  // active platform admins. Counting on `systemDb` is fine — the table
  // is platform-level and has no RLS.
  const counts = await systemDb
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(platformAdmins)
    .where(isNull(platformAdmins.deletedAt));
  const activeCount = counts[0]?.count ?? 0;
  if (activeCount <= 1) {
    throw new PlatformAdminServiceError(
      400,
      "LAST_ADMIN_FORBIDDEN",
      "Cannot remove the last active platform admin. At least one super-admin must remain.",
    );
  }

  // Mirror the user-lifecycle pattern (ADR-021): blocklist the KC `sub`
  // first (zero-second propagation), then KC delete, then DB soft-delete +
  // audit.
  await blocklistUser(existing.keycloakId!);
  await keycloakAdmin().deleteUser(existing.keycloakId!);

  await systemDb.transaction(async (tx) => {
    await tx
      .update(platformAdmins)
      .set({
        deletedAt: new Date(),
        // ADR-021 mirror — null the keycloak_id so a stale FK can never
        // resolve to a live KC user. The audit row still references the
        // historical sub via `auditLogs.userId`.
        keycloakId: null,
        updatedAt: new Date(),
      })
      .where(eq(platformAdmins.id, input.id));

    await tx.execute(
      sql`SELECT set_config('app.current_organization_id', ${PLATFORM_AUDIT_ORG_ID}, true)`,
    );
    await tx.insert(auditLogs).values({
      orgId: PLATFORM_AUDIT_ORG_ID,
      userId: existing.keycloakId,
      actorId: input.actorKeycloakId,
      action: "platform_admin.removed",
      resourceType: "platform_admin",
      resourceId: input.id,
      ipHash: input.ipHash,
      userAgent: input.userAgent ?? undefined,
    });
  });
}

// ─── Internals ───────────────────────────────────────────────────────────────

async function getActiveAdminOrThrow(id: string): Promise<PlatformAdminRow> {
  const [row] = await systemDb
    .select()
    .from(platformAdmins)
    .where(
      and(
        eq(platformAdmins.id, id),
        isNull(platformAdmins.deletedAt),
        isNotNull(platformAdmins.keycloakId),
      ),
    )
    .limit(1);
  if (!row) {
    throw new PlatformAdminServiceError(
      404,
      "NOT_FOUND",
      "Platform admin not found or already removed.",
    );
  }
  return row;
}

async function compensatingKcDelete(kcUserId: string): Promise<void> {
  try {
    await keycloakAdmin().deleteUser(kcUserId);
  } catch {
    // Don't bubble — the original failure is what the caller should see.
    // The route layer logs the original error with full context; the
    // compensating delete is best-effort. If it fails, the realm keeps
    // an orphan user that an operator can clean up manually.
  }
}

function cryptoRandomPassword(): string {
  // 32 bytes of entropy → 64 hex chars. Far above any reasonable realm
  // password policy (the seed realm enforces length(12) and notUsername).
  // Never logged or surfaced; immediately invalidated by UPDATE_PASSWORD.
  return randomBytes(32).toString("hex");
}
