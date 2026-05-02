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
import pino from "pino";
import { env } from "../../env.js";
import { systemDb } from "../../lib/db.js";
import { KeycloakUserExistsError, keycloakAdmin } from "../../lib/keycloak-admin.js";
import { blocklistUser } from "../session/service.js";

const logger = pino({ name: "platform-admins-service" });

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

/** Keycloak client id the password-reset email link should land on. */
const KC_WEB_CLIENT_ID = "givernance-web";

/**
 * Where the UPDATE_PASSWORD email link redirects after password set.
 * Resolves from `APP_URL` so dev / staging / prod each land the new admin
 * on the right back-office origin. KC will reject a redirect that isn't
 * registered on `givernance-web` — the realm seed already lists
 * `<APP_URL>/*` for every environment.
 */
const KC_PLATFORM_ADMIN_REDIRECT_URL = `${env.APP_URL.replace(/\/$/, "")}/admin/platform-admins`;

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

export async function getPlatformAdminById(
  id: string,
  opts: { includeDeleted?: boolean } = {},
): Promise<PlatformAdminRow | null> {
  const conditions: SQL[] = [eq(platformAdmins.id, id)];
  if (!opts.includeDeleted) {
    // Default: hide offboarded admins from the detail surface — same
    // posture as `listPlatformAdmins`. Routes that explicitly want the
    // historical record opt in via `includeDeleted: true`. Closes the
    // data-architect minor #6.
    conditions.push(isNull(platformAdmins.deletedAt));
  }
  const [row] = await systemDb
    .select()
    .from(platformAdmins)
    .where(and(...conditions))
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

  // Provision the KC user. The throwaway password is `temporary: true` so
  // even if the UPDATE_PASSWORD email-trigger path fails afterward, the
  // user CANNOT log in with it — KC will force them through the password
  // reset on first login regardless. Defense-in-depth (security review m4).
  let kcUserId: string;
  try {
    const out = await keycloakAdmin().createUser({
      email,
      firstName: input.firstName,
      lastName: input.lastName,
      // 32 bytes of entropy in hex — never logged or transmitted; KC will
      // force UPDATE_PASSWORD on first login because `temporary: true`.
      password: cryptoRandomPassword(),
      emailVerified: true,
      temporary: true,
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

  // Phase 1 — assign the realm role + Org membership. Both are required
  // for the user to function as a super-admin. A mid-flight failure here
  // means the user has no super-admin authority and must be rolled back
  // (otherwise the realm accumulates orphans with partial state).
  try {
    await keycloakAdmin().assignRealmRoleToUser(kcUserId, role);
    await keycloakAdmin().attachUserToOrg(org.id, kcUserId);
  } catch (err) {
    await compensatingKcDelete(kcUserId, "role/org-assignment-failed");
    if (err instanceof PlatformAdminServiceError) throw err;
    throw new PlatformAdminServiceError(
      502,
      "KEYCLOAK_FAILURE",
      `Keycloak provisioning failed mid-flight; rolled back the realm user. Original error: ${(err as Error).message}`,
    );
  }

  // Phase 2 — trigger the UPDATE_PASSWORD email. The user is fully
  // provisioned at this point (role + Org membership). If the email
  // delivery fails (transient SMTP, KC 5xx) we DO NOT roll back the KC
  // user — instead we proceed to insert the `platform_admins` row and
  // surface a 502 to the operator. The operator can re-trigger the
  // email via `POST /v1/admin/platform-admins/:id/reset-password`
  // (platform review M2). Tearing down the KC user on a transient SMTP
  // outage would force the operator to recreate the row with a new
  // `platform_admins.id` and lose audit-trail continuity.
  let emailDeliveryFailed: Error | null = null;
  try {
    await keycloakAdmin().sendExecuteActionsEmail(kcUserId, ["UPDATE_PASSWORD"], {
      lifespanSec: PASSWORD_RESET_LIFESPAN_SEC,
      // Land the new admin on the back-office login page after they
      // finish the UPDATE_PASSWORD flow (platform review M3). Without
      // this, KC dumps them on the bare account console.
      clientId: KC_WEB_CLIENT_ID,
      ...(KC_PLATFORM_ADMIN_REDIRECT_URL ? { redirectUri: KC_PLATFORM_ADMIN_REDIRECT_URL } : {}),
    });
  } catch (err) {
    emailDeliveryFailed = err as Error;
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

  // Surface the email-delivery failure as a 502 AFTER the row is in place,
  // so the operator gets a structured signal but the row exists for them
  // to retry against via `/reset-password`. The compensating-delete path
  // is NOT taken here — the user has a temporary password they cannot
  // use, the role + Org are correct, the row is queryable.
  if (emailDeliveryFailed) {
    throw new PlatformAdminServiceError(
      502,
      "KEYCLOAK_FAILURE",
      `Platform admin provisioned (id=${created.id}), but the UPDATE_PASSWORD email failed to send. Use POST /v1/admin/platform-admins/${created.id}/reset-password to retry. Original error: ${emailDeliveryFailed.message}`,
    );
  }

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
  // Self-removal guard — fast pre-flight before opening a transaction.
  // The active-row + last-admin checks happen inside the SERIALIZABLE
  // transaction below so two concurrent operators racing on the
  // second-to-last admin can't both pass the count gate.
  const preflight = await getActiveAdminOrThrow(input.id);
  if (preflight.keycloakId === input.actorKeycloakId) {
    throw new PlatformAdminServiceError(
      400,
      "SELF_REMOVAL_FORBIDDEN",
      "Operators cannot soft-delete their own platform-admin row. Ask another super-admin.",
    );
  }

  // Atomic delete + last-admin guard + audit insert in one SERIALIZABLE
  // transaction (security review M1, QA M4, data architect #13). The
  // count + UPDATE happen against the same snapshot; concurrent removers
  // serialize on the platform_admins lock and the loser sees activeCount
  // = 1 and gets a 400.
  //
  // We also row-lock the target admin's row (`FOR UPDATE`) so two
  // operators racing on the SAME id can't both enter — Postgres queues
  // them and the second sees `keycloak_id = null` after the first commits.
  const targetKeycloakId = await systemDb.transaction(
    async (tx) => {
      // Re-read the row INSIDE the tx, locked. If two requests target the
      // same admin id, the second blocks until the first commits, then sees
      // the post-soft-delete state and exits with NOT_FOUND.
      const lockedRows = await tx.execute<{
        keycloak_id: string;
      }>(sql`
        SELECT keycloak_id
        FROM platform_admins
        WHERE id = ${input.id}
          AND deleted_at IS NULL
          AND keycloak_id IS NOT NULL
        FOR UPDATE
      `);
      const locked = lockedRows.rows[0];
      if (!locked) {
        throw new PlatformAdminServiceError(
          404,
          "NOT_FOUND",
          "Platform admin not found or already removed.",
        );
      }
      const lockedKeycloakId = locked.keycloak_id;

      // Atomic last-admin guard — count active rows under the same
      // tx-snapshot. If we're the second-to-last and a sibling tx also
      // targets the last admin, one of us serializes and aborts.
      const counts = await tx
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

      // Soft-delete the row + null keycloak_id (ADR-021 mirror). Audit
      // row inside the same tx so audit chain and lifecycle land
      // atomically.
      await tx
        .update(platformAdmins)
        .set({ deletedAt: new Date(), keycloakId: null, updatedAt: new Date() })
        .where(eq(platformAdmins.id, input.id));

      await tx.execute(
        sql`SELECT set_config('app.current_organization_id', ${PLATFORM_AUDIT_ORG_ID}, true)`,
      );
      await tx.insert(auditLogs).values({
        orgId: PLATFORM_AUDIT_ORG_ID,
        userId: lockedKeycloakId,
        actorId: input.actorKeycloakId,
        action: "platform_admin.removed",
        resourceType: "platform_admin",
        resourceId: input.id,
        ipHash: input.ipHash,
        userAgent: input.userAgent ?? undefined,
      });
      return lockedKeycloakId;
    },
    { isolationLevel: "serializable" },
  );

  // Token revocation lives outside the DB tx — a Redis or KC failure
  // here is independent of the soft-delete commit. The blocklist is set
  // before KC.deleteUser so the ADR-021 zero-second propagation window
  // closes immediately, even if the KC delete fails. If KC.deleteUser
  // fails (5xx), the row is already soft-deleted in the DB and the sub
  // is on the blocklist — operator can manually clean up the realm.
  try {
    await blocklistUser(targetKeycloakId);
  } catch (err) {
    logger.error(
      { err, kcSub: targetKeycloakId, adminId: input.id },
      "platform_admin: soft-delete committed but blocklist write failed; access revocation falls back to KC user delete",
    );
  }
  try {
    await keycloakAdmin().deleteUser(targetKeycloakId);
  } catch (err) {
    logger.error(
      { err, kcSub: targetKeycloakId, adminId: input.id },
      "platform_admin: soft-delete committed but KC user delete failed; orphan KC user remains, manual cleanup required",
    );
  }
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

async function compensatingKcDelete(kcUserId: string, reason: string): Promise<void> {
  try {
    await keycloakAdmin().deleteUser(kcUserId);
    logger.warn(
      { kcUserId, reason },
      "platform_admin: compensating KC user delete after partial create",
    );
  } catch (err) {
    // Don't bubble — the original failure is what the caller should see.
    // BUT we MUST log the orphan loud so SOC has a structured signal:
    // a KC user with `super_admin` realm role + platform Org membership
    // exists with no `platform_admins` row and the operator was told the
    // create failed. This is the worst-case scenario this module can
    // produce; an unattended orphan retains realm-level super-admin
    // authority. (Platform review C1, security review m2.)
    logger.error(
      { err, kcUserId, reason },
      "platform_admin: ORPHAN — compensating KC delete failed; realm has a super_admin user with no DB row, manual cleanup required",
    );
  }
}

function cryptoRandomPassword(): string {
  // 32 bytes of entropy → 64 hex chars. Far above any reasonable realm
  // password policy (the seed realm enforces length(12) and notUsername).
  // Never logged or surfaced; immediately invalidated by UPDATE_PASSWORD.
  return randomBytes(32).toString("hex");
}
