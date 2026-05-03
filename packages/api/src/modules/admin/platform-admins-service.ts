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
 * `platform_admin.removed`. Audit rows are written under the platform
 * sentinel tenant (slug `__platform__`, ADR-022 amendment) so an SOC
 * reviewer can grep one tenant id for the full platform-admin lifecycle
 * without UNIONing across customer tenants. The id is resolved at
 * runtime via `getPlatformOrgId` from the `tenants` row; no magic-UUID
 * literal is pinned in code.
 */

import { APP_DEFAULT_LOCALE, type Locale } from "@givernance/shared/i18n";
import {
  auditLogs,
  invitations,
  outboxEvents,
  platformAdmins,
  type platformAdmins as platformAdminsTable,
  tenants,
  users,
} from "@givernance/shared/schema";
import { and, asc, desc, eq, gt, ilike, isNotNull, isNull, or, type SQL, sql } from "drizzle-orm";
import pino from "pino";
import { systemDb } from "../../lib/db.js";
import {
  KeycloakAdminError,
  type KeycloakOrganization,
  KeycloakUserExistsError,
  keycloakAdmin,
} from "../../lib/keycloak-admin.js";
import { blocklistUser } from "../session/service.js";

const logger = pino({ name: "platform-admins-service" });

/**
 * Slug used to identify the platform sentinel tenant row (ADR-022
 * amendment). The row exists solely so `audit_logs.org_id` can FK to a
 * real `tenants.id` for platform-level lifecycle events; it is hidden
 * from every customer-facing list endpoint by `status = 'archived'` +
 * the `__platform__` reserved-slug pattern. We resolve the id from this
 * slug at runtime (cached per process) instead of pinning the literal
 * `00000000-0000-0000-0000-0000000000a1` in the codebase — that literal
 * was the last magic-UUID `PLATFORM_TENANT_ID` carry-over ADR-022
 * originally set out to remove.
 */
const PLATFORM_TENANT_SLUG = "__platform__";

/**
 * Lifespan for the UPDATE_PASSWORD email link (4 hours). Long enough that
 * a new admin can set up at their own pace; short enough that a leaked
 * email cannot be redeemed days later. The realm-level default is
 * typically 12h; we pin a tighter value here.
 */
const PASSWORD_RESET_LIFESPAN_SEC = 4 * 60 * 60;

const SUPER_ADMIN_ROLE_NAME = "super_admin";
const PLATFORM_ORG_ALIAS = "platform";

// ─── Module-local lookup caches ─────────────────────────────────────────────
//
// All three values are realm-lifetime stable (the platform tenant row,
// the `super_admin` realm role, the `platform` Keycloak Organization).
// Caching them per process saves a round-trip on every accept / rename /
// reset / soft-delete. Cache misses re-hit the source so a re-imported
// realm or a re-seeded sentinel row recovers without a process restart;
// stale `{id, name}` cache entries that turn into 404s at use-site are
// invalidated by the call site (see the accept flow's role + org
// catch-blocks below).

let cachedPlatformOrgId: string | null = null;
let cachedSuperAdminRole: { id: string; name: string } | null = null;
let cachedPlatformOrg: KeycloakOrganization | null = null;

async function getPlatformOrgId(): Promise<string> {
  if (cachedPlatformOrgId) return cachedPlatformOrgId;
  const [row] = await systemDb
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, PLATFORM_TENANT_SLUG))
    .limit(1);
  if (!row) {
    // Deployment bootstrap missed the sentinel insert. Bail loud — every
    // platform-admin write needs this row to FK against `audit_logs.org_id`.
    // (ADR-022 amendment.)
    throw new Error(
      `Platform sentinel tenant (slug='${PLATFORM_TENANT_SLUG}') is missing — apply the deploy bootstrap insert (ADR-022 amendment).`,
    );
  }
  cachedPlatformOrgId = row.id;
  return row.id;
}

async function getCachedSuperAdminRole(): Promise<{ id: string; name: string } | null> {
  if (cachedSuperAdminRole) return cachedSuperAdminRole;
  const role = await keycloakAdmin().getRealmRole(SUPER_ADMIN_ROLE_NAME);
  if (role) cachedSuperAdminRole = role;
  return role;
}

async function getCachedPlatformOrg(): Promise<KeycloakOrganization | null> {
  if (cachedPlatformOrg) return cachedPlatformOrg;
  const org = await keycloakAdmin().getOrganizationByAlias(PLATFORM_ORG_ALIAS);
  if (org) cachedPlatformOrg = org;
  return org;
}

function invalidatePlatformLookupCache() {
  cachedSuperAdminRole = null;
  cachedPlatformOrg = null;
  // `cachedPlatformOrgId` is DB-backed off the immutable `__platform__`
  // slug — no scenario invalidates it short of the row being deleted,
  // which is itself a deploy-bootstrap regression (see `getPlatformOrgId`).
}

/**
 * Test-only escape hatch — drains the module-local caches so a Vitest
 * `beforeEach` can guarantee a fresh KC round-trip per case. Not exported
 * from the package barrel; tests reach in by direct file import.
 */
export const __testInvalidatePlatformLookupCache = invalidatePlatformLookupCache;

// Note on `sendExecuteActionsEmail` parameters:
//
// We deliberately pass NEITHER `client_id` NOR `redirect_uri` to KC's
// `execute-actions-email` endpoint. Both attempt to re-enter an auth
// flow after the action completes — `redirect_uri` does an inline
// redirect, and `client_id` triggers a server-side hop to the client's
// authorize URL. Both require the auth-session cookie KC consumed
// during UPDATE_PASSWORD to still be present, which is fragile (short
// TTL, browser cookie policies, multi-tab).
//
// Without either param, KC ends the flow on the standard "info" page
// (`info.ftl`). The custom Givernance theme renders that page with a
// stable link to the SPA login that does NOT depend on auth-session
// state. The user clicks it, lands on the SPA, kicks off a fresh OIDC
// code flow with their freshly-set password — works every time.
//
// Caught in dev: PR #253 smoke-test feedback (KC_RESTART cookie missing
// after UPDATE_PASSWORD).

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
  /**
   * Operator's locale (resolved from `Accept-Language` at the route
   * boundary). Threads through to the outbox payload so the invite email
   * lands in the language the operator was using when they issued it —
   * the best signal we have for the new admin's preferred language until
   * they accept and pick their own. Optional; falls back to
   * `APP_DEFAULT_LOCALE` when omitted.
   */
  locale?: Locale;
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

// ─── Invite (create flow, post-PR-#253-smoke-feedback refactor) ──────────────

/**
 * Result of `invitePlatformAdmin`. Returns the invitation id (NOT a
 * `platform_admins.id` — the row doesn't exist yet) so the caller can
 * surface "invitation sent" without exposing identity-surface state
 * before the invitee accepts.
 */
export interface InviteResult {
  invitationId: string;
  email: string;
  firstName: string;
  lastName: string;
  expiresAt: Date;
}

/**
 * Issue an invitation for a new platform admin (issue #254, refactor
 * fix-commit 4 after KC `execute-actions-email` smoke-test issues).
 *
 * Behaviour:
 *   1. Identity-invariant check — refuse if email belongs to a tenant
 *      `users` row (ADR-022) or another active platform admin.
 *   2. Insert an `invitations` row (purpose = `platform_admin_invite`)
 *      under the platform sentinel tenant with a fresh token.
 *   3. Emit `platform_admin.invited` to the outbox so the worker sends
 *      the email out-of-band.
 *   4. Audit `platform_admin.invited` under the platform sentinel
 *      tenant.
 *
 * The KC user, role assignment, Org membership, and `platform_admins`
 * row all land at *accept* time (`acceptPlatformAdminInvitation`),
 * triggered when the invitee submits the password form on the public
 * accept page. This avoids KC's `execute-actions-email` flow entirely
 * — which had three compounding issues in dev (KC_RESTART cookie
 * timeout, broken back-link in `info.ftl`, "already authenticated as
 * different user" rejection). The Givernance-side accept page handles
 * the session-conflict UX gracefully, same posture as `team_invite`.
 */
export async function invitePlatformAdmin(input: CreateInput): Promise<InviteResult> {
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

  // Same-table collision on a pending (not-yet-accepted, not-yet-expired)
  // invitation: don't issue duplicates. The operator can re-trigger the
  // existing invitation via the (separate) reset-invitation endpoint —
  // out of scope for this fix.
  const [pendingInvite] = await systemDb
    .select({ id: invitations.id })
    .from(invitations)
    .where(
      and(
        eq(invitations.purpose, "platform_admin_invite"),
        sql`lower(${invitations.email}) = ${email}`,
        isNull(invitations.acceptedAt),
        gt(invitations.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (pendingInvite) {
    throw new PlatformAdminServiceError(
      409,
      "EMAIL_TAKEN_BY_PLATFORM_ADMIN",
      "A pending platform-admin invitation already exists for this email.",
    );
  }

  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
  const platformOrgId = await getPlatformOrgId();

  // The invite email goes to a brand-new identity that has no stored
  // language preference yet — the operator's locale (read from the
  // `Accept-Language` header at the route boundary) is the best signal we
  // have. Fall back to `APP_DEFAULT_LOCALE` if the route didn't supply
  // one (test paths, programmatic callers).
  const inviteLocale = input.locale ?? APP_DEFAULT_LOCALE;

  return systemDb.transaction(async (tx) => {
    const [row] = await tx
      .insert(invitations)
      .values({
        orgId: platformOrgId,
        email,
        firstName: input.firstName,
        lastName: input.lastName,
        // `users.role` enum doesn't have `super_admin`; the realm role
        // is the source of truth for super-admin RBAC. Stamping
        // `org_admin` here for parity with team_invite and so the
        // schema constraint is satisfied. The accept flow ignores it.
        role: "org_admin",
        purpose: "platform_admin_invite",
        expiresAt,
      })
      .returning({
        id: invitations.id,
        email: invitations.email,
        firstName: invitations.firstName,
        lastName: invitations.lastName,
        expiresAt: invitations.expiresAt,
      });
    if (!row) throw new Error("invitePlatformAdmin: insert returned no row");

    // Outbox event → relay → BullMQ → worker `processPlatformAdminInviteEmail`.
    // Same SEC-7 posture as team_invite: do NOT put the raw token in the
    // outbox payload — the worker reads it back from the row inside its
    // own trust boundary.
    await tx.insert(outboxEvents).values({
      tenantId: platformOrgId,
      type: "platform_admin.invited",
      payload: {
        tenantId: platformOrgId,
        invitationId: row.id,
        email: row.email,
        inviterKeycloakId: input.actorKeycloakId,
        expiresAt: row.expiresAt.toISOString(),
        locale: inviteLocale,
      },
    });

    await tx.execute(sql`SELECT set_config('app.current_organization_id', ${platformOrgId}, true)`);
    await tx.insert(auditLogs).values({
      orgId: platformOrgId,
      // The invitee's KC sub doesn't exist yet — leave userId null until
      // the accept flow lands the platform_admins row.
      userId: null,
      actorId: input.actorKeycloakId,
      action: "platform_admin.invited",
      resourceType: "invitation",
      resourceId: row.id,
      newValues: { purpose: "platform_admin_invite" },
      ipHash: input.ipHash,
      userAgent: input.userAgent ?? undefined,
    });

    return {
      invitationId: row.id,
      email: row.email,
      firstName: row.firstName ?? input.firstName,
      lastName: row.lastName ?? input.lastName,
      expiresAt: row.expiresAt,
    };
  });
}

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ─── Accept (public flow, no auth required) ───────────────────────────────────

export interface InvitationDetail {
  email: string;
  firstName: string;
  lastName: string;
  expiresAt: Date;
}

/**
 * Public read of an invitation by token. Returns enough to render the
 * accept page; never returns the token itself or any sensitive
 * metadata. Returns null on missing / expired / accepted so the route
 * surfaces a single 404 (anti-enumeration of valid token shape).
 */
export async function getPlatformAdminInvitationByToken(
  token: string,
): Promise<InvitationDetail | null> {
  const [row] = await systemDb
    .select({
      email: invitations.email,
      firstName: invitations.firstName,
      lastName: invitations.lastName,
      acceptedAt: invitations.acceptedAt,
      expiresAt: invitations.expiresAt,
    })
    .from(invitations)
    .where(and(eq(invitations.token, token), eq(invitations.purpose, "platform_admin_invite")))
    .limit(1);
  if (!row) return null;
  if (row.acceptedAt) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  return {
    email: row.email,
    firstName: row.firstName ?? "",
    lastName: row.lastName ?? "",
    expiresAt: row.expiresAt,
  };
}

export interface AcceptInput {
  token: string;
  password: string;
  firstName: string;
  lastName: string;
  ipHash: string | null;
  userAgent: string | null;
  /**
   * Locale the invitee was viewing the accept page in. Stamped onto the
   * Keycloak user's `locale` attribute so future emails (e.g. the
   * reset-password flow) land in the language they picked at first
   * contact, instead of falling back to the realm-wide default. Optional;
   * KC simply omits the attribute if absent.
   */
  locale?: Locale;
}

/**
 * Accept a platform-admin invitation:
 *   1. Validate token + state (must be unaccepted + unexpired).
 *   2. Pre-flight Keycloak realm-role + Organization lookup.
 *   3. `kcAdmin.createUser` with the invitee's chosen password
 *      (NOT temporary — they just typed it; KC respects it as their
 *      working credential).
 *   4. Assign `super_admin` realm role + attach to platform Org.
 *   5. INSERT `platform_admins` row + mark invitation accepted +
 *      audit `platform_admin.created`. All in one transaction.
 *
 * Compensating delete on KC failure mirrors the previous create path.
 */
export async function acceptPlatformAdminInvitation(input: AcceptInput): Promise<PlatformAdminRow> {
  // Validate the invitation first — atomic with the eventual
  // accepted_at write further below to prevent double-accept.
  const [invite] = await systemDb
    .select({
      id: invitations.id,
      email: invitations.email,
      acceptedAt: invitations.acceptedAt,
      expiresAt: invitations.expiresAt,
    })
    .from(invitations)
    .where(
      and(eq(invitations.token, input.token), eq(invitations.purpose, "platform_admin_invite")),
    )
    .limit(1);
  if (!invite) {
    throw new PlatformAdminServiceError(404, "NOT_FOUND", "Invitation not found.");
  }
  if (invite.acceptedAt) {
    throw new PlatformAdminServiceError(404, "NOT_FOUND", "Invitation has already been accepted.");
  }
  if (invite.expiresAt.getTime() <= Date.now()) {
    throw new PlatformAdminServiceError(404, "NOT_FOUND", "Invitation has expired.");
  }

  const platformOrgId = await getPlatformOrgId();

  const [role, org] = await Promise.all([getCachedSuperAdminRole(), getCachedPlatformOrg()]);
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

  // KC create with the user's chosen password. NOT temporary — they
  // just typed it; KC respects it as their working credential.
  let kcUserId: string;
  try {
    const out = await keycloakAdmin().createUser({
      email: invite.email,
      firstName: input.firstName,
      lastName: input.lastName,
      password: input.password,
      emailVerified: true,
      temporary: false,
      attributes: {
        // Same `org_id` user attribute as the seeded admin so the JWT
        // carries the flat `org_id` claim that `verifyKeycloakJwt`
        // requires. (See PR #253 review feedback.) Resolved at runtime
        // from the platform sentinel `tenants` row (slug `__platform__`)
        // so the value matches what audit / outbox writes use — no
        // magic-UUID literal in app code.
        org_id: [platformOrgId],
        role: ["org_admin"],
        // KC uses the user's `locale` attribute to pick the email
        // template language for built-in flows (UPDATE_PASSWORD etc).
        // We only set it when the invitee picked a non-default locale —
        // omitting the attribute lets KC fall back to its realm-wide
        // default, which matches our APP_DEFAULT_LOCALE.
        ...(input.locale ? { locale: [input.locale] } : {}),
      },
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

  try {
    await keycloakAdmin().assignRealmRoleToUser(kcUserId, role);
    await keycloakAdmin().attachUserToOrg(org.id, kcUserId);
  } catch (err) {
    await compensatingKcDelete(kcUserId, "accept-side-effects-failed");
    if (err instanceof PlatformAdminServiceError) throw err;

    // Race against a re-imported (or just-deleted) realm — between the
    // pre-flight `getCachedSuperAdminRole` / `getCachedPlatformOrg`
    // lookups above and the writes here, the role/org could vanish or
    // be replaced with a fresh id. Without this branch the operator
    // sees a generic `KEYCLOAK_FAILURE` (502) and has to dig through
    // the wrapped error message to know whether to re-import the realm
    // or escalate to KC ops. The cached `{id, name}` is stale either
    // way, so invalidate before bubbling so the next attempt re-fetches.
    if (err instanceof KeycloakAdminError && err.status === 404) {
      invalidatePlatformLookupCache();
      const code = err.path?.includes("/role-mappings/")
        ? "KEYCLOAK_ROLE_MISSING"
        : "KEYCLOAK_ORG_MISSING";
      throw new PlatformAdminServiceError(
        502,
        code,
        `Keycloak ${code === "KEYCLOAK_ROLE_MISSING" ? `realm role '${SUPER_ADMIN_ROLE_NAME}'` : `Organization '${PLATFORM_ORG_ALIAS}'`} disappeared between pre-flight and write — realm needs re-importing.`,
      );
    }

    throw new PlatformAdminServiceError(
      502,
      "KEYCLOAK_FAILURE",
      `Keycloak provisioning failed mid-flight; rolled back the realm user. Original error: ${(err as Error).message}`,
    );
  }

  // DB writes + invitation marking + audit in one transaction. The
  // `acceptedAt` clause in the UPDATE prevents double-accept races.
  return systemDb.transaction(async (tx) => {
    const updateRes = await tx
      .update(invitations)
      .set({ acceptedAt: new Date() })
      .where(and(eq(invitations.id, invite.id), isNull(invitations.acceptedAt)))
      .returning({ id: invitations.id });
    if (updateRes.length === 0) {
      // Another request accepted between our SELECT and UPDATE.
      throw new PlatformAdminServiceError(
        409,
        "NOT_FOUND",
        "Invitation has already been accepted.",
      );
    }

    const [row] = await tx
      .insert(platformAdmins)
      .values({
        keycloakId: kcUserId,
        email: invite.email,
        firstName: input.firstName,
        lastName: input.lastName,
      })
      .returning();
    if (!row) throw new Error("acceptPlatformAdminInvitation: insert returned no row");

    await tx.execute(sql`SELECT set_config('app.current_organization_id', ${platformOrgId}, true)`);
    await tx.insert(auditLogs).values({
      orgId: platformOrgId,
      userId: kcUserId,
      // No `actorId` — the invitee accepted the invitation themselves.
      // The original inviter is recorded on the `platform_admin.invited`
      // audit row, joinable by `resource_id` (invitation.id) ↔
      // (the prior audit row's resourceId).
      actorId: null,
      action: "platform_admin.created",
      resourceType: "platform_admin",
      resourceId: row.id,
      ipHash: input.ipHash,
      userAgent: input.userAgent ?? undefined,
    });
    return row;
  });
}

// ─── Rename ──────────────────────────────────────────────────────────────────

export async function updatePlatformAdminName(input: UpdateNameInput): Promise<PlatformAdminRow> {
  const existing = await getActiveAdminOrThrow(input.id);
  const platformOrgId = await getPlatformOrgId();

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

    await tx.execute(sql`SELECT set_config('app.current_organization_id', ${platformOrgId}, true)`);
    await tx.insert(auditLogs).values({
      orgId: platformOrgId,
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
  const platformOrgId = await getPlatformOrgId();

  await keycloakAdmin().sendExecuteActionsEmail(existing.keycloakId!, ["UPDATE_PASSWORD"], {
    lifespanSec: PASSWORD_RESET_LIFESPAN_SEC,
    // No `clientId` / `redirectUri` — see the create flow's comment.
  });

  await systemDb.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_organization_id', ${platformOrgId}, true)`);
    await tx.insert(auditLogs).values({
      orgId: platformOrgId,
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

  const platformOrgId = await getPlatformOrgId();

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
        sql`SELECT set_config('app.current_organization_id', ${platformOrgId}, true)`,
      );
      await tx.insert(auditLogs).values({
        orgId: platformOrgId,
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
