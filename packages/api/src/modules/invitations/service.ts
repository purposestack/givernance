/**
 * Team invitation service (issue #145).
 *
 * Structural twin of `modules/signup/service.ts` — the same recovery-state
 * matrix and hijack-vs-takeover discriminator apply, with two scoping
 * differences:
 *
 *  - The tenant is already `active`; we never flip status here.
 *  - The inviter is an org_admin (or the seeded super_admin via
 *    `inviteFirstEnterpriseUser`), not the operator themselves.
 *
 * Recovery half-states the accept endpoint must handle (each one came up
 * during the PR #143 signup work and has the same shape here):
 *
 *   1. **First accept** — invitation `acceptedAt IS NULL`, no `users` row,
 *      no KC artefact for this email. Straight first-time path.
 *   2. **No KC credential** — `users` row exists with `keycloak_id IS NULL`
 *      (e.g. an operator created the row by hand, or a prior accept tx
 *      rolled back after the user INSERT). Recovery: createUser + attach +
 *      patch `keycloak_id` onto the existing row.
 *   3. **No KC Organization yet** — `users.keycloak_id` set, but
 *      `tenant.keycloak_org_id IS NULL` (the seed-via-super-admin path on
 *      enterprise tenants ran before issue #114 shipped). Recovery: get-or-
 *      create the Org, reset the bound user's password, patch attributes,
 *      attach.
 *
 * The discriminator between "legitimate recovery" and "hijack attempt" is
 * `users.keycloak_id` — read in the accept tx before any KC call. If it's
 * set, we own that KC user and may safely re-bind. If it's null and KC
 * reports the email exists (409 on createUser), we throw
 * `KeycloakUserExistsError` and the route surfaces a generic 410 (no
 * enumeration oracle), with a `team_invite.kc_user_exists` warn log.
 *
 * Patterns inherited verbatim from signup/service.ts:
 *  - Owner-role DB on the unauthenticated path (token IS the boundary).
 *  - `FOR UPDATE` on the invitation row to serialise concurrent accepts.
 *  - Outbox dedup via `RETURNING (xmax = 0)` on user upsert.
 *  - KC org adoption only when `attributes.org_id` matches THIS tenant.
 *  - UUID-shape preflight on KC org id before binding to `tenants` (the
 *    `tenants_keycloak_org_id_uuid_chk` CHECK constraint).
 *  - SEC-7: outbox payloads never carry the raw token; the email worker
 *    looks it up by invitation id inside its own trust boundary.
 *
 * Known caveat (shared with signup/service.ts, tracked there as the
 * compensating-delete follow-up): if KC operations succeed but the DB tx
 * rolls back, the resulting KC artefacts orphan with no compensating
 * delete. The recovery half-states above are designed to absorb the next
 * accept attempt; a long-running orphan is best resolved by a periodic
 * KC-vs-DB reconciliation job.
 */

import { randomUUID } from "node:crypto";
import { PINO_REDACT_PATHS } from "@givernance/shared/constants";
import { APP_DEFAULT_LOCALE, isSupportedLocale, type Locale } from "@givernance/shared/i18n";
import { auditLogs, invitations, outboxEvents, tenants, users } from "@givernance/shared/schema";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import pino from "pino";
import { systemDb, withTenantContext } from "../../lib/db.js";
import {
  type KeycloakAdminClient,
  KeycloakAdminError,
  KeycloakUserExistsError,
  keycloakAdmin,
} from "../../lib/keycloak-admin.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const log = pino({
  name: "invitations-service",
  redact: { paths: [...PINO_REDACT_PATHS], censor: "[REDACTED]" },
});

const INVITATION_TTL_DAYS = 7;
/** Resend rotates the token; this is the same TTL the create path uses. */
const RESEND_TTL_DAYS = INVITATION_TTL_DAYS;

export type InviteRole = "org_admin" | "user" | "viewer";

/**
 * Resolve the BCP-47 locale to stamp on a team-invite email job (issue #153).
 *
 * Implements the 3-layer resolution chain from ADR-015 amendment:
 *
 *   1. `users.locale` (per-recipient personal preference) — looked up by
 *      `(orgId, email)` in case the invitee already exists as a member of
 *      this tenant under another role (re-invite scenarios).
 *   2. `tenants.default_locale` (organisation default) — populated at
 *      tenant create time and migration-backfilled, NOT NULL.
 *   3. `APP_DEFAULT_LOCALE` ('fr', per ADR-015) — only reached if a column
 *      check is bypassed by a future schema change; defensive floor.
 *
 * Email match uses `lower()` on both sides for the same defence-in-depth
 * reason as the accept-flow hijack discriminator: `users.email` has no
 * schema-level case-folding constraint and a historical mixed-case row
 * shouldn't silently miss the per-user override.
 */
async function resolveInviteeLocale(
  tx: Parameters<Parameters<typeof withTenantContext>[1]>[0],
  tenantId: string,
  email: string,
): Promise<{ locale: Locale; tenantDefaultLocale: Locale }> {
  const [tenantRow] = await tx
    .select({ defaultLocale: tenants.defaultLocale })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  const tenantDefaultLocale: Locale = isSupportedLocale(tenantRow?.defaultLocale)
    ? tenantRow.defaultLocale
    : APP_DEFAULT_LOCALE;

  const [userRow] = await tx
    .select({ locale: users.locale })
    .from(users)
    .where(and(eq(users.orgId, tenantId), sql`lower(${users.email}) = lower(${email})`))
    .limit(1);

  const personalLocale = userRow?.locale;
  const locale: Locale = isSupportedLocale(personalLocale) ? personalLocale : tenantDefaultLocale;
  return { locale, tenantDefaultLocale };
}

// ─── Create ─────────────────────────────────────────────────────────────────

export interface CreateInvitationInput {
  orgId: string;
  email: string;
  role?: InviteRole;
  /** Keycloak `sub` of the inviting org_admin (resolved to a `users.id`). */
  inviterKeycloakId: string;
  ipHash?: string;
  userAgent?: string;
}

export interface CreateInvitationResult {
  id: string;
  orgId: string;
  email: string;
  role: InviteRole;
  invitedById: string | null;
  acceptedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

export type CreateInvitationError = { kind: "already_member" } | { kind: "already_invited" };

/**
 * Insert a `team_invite` invitation, emit `invitation.created`, and audit.
 *
 * Returns `already_member` if a `users` row with the same email already
 * exists in this tenant — the operator's intent (loop them in) is already
 * satisfied. Returns `already_invited` if a non-expired pending invitation
 * is already on file — let the operator resend instead of fanning out
 * duplicate links to the same inbox.
 *
 * Both error cases are surfaced as 409 by the route. We deliberately do NOT
 * collapse them with the underlying DB unique-violation: the operator is
 * already authenticated, so anti-enumeration concerns from the public
 * signup flow don't apply here.
 */
export async function createTeamInvitation(
  input: CreateInvitationInput,
): Promise<
  { ok: true; data: CreateInvitationResult } | { ok: false; error: CreateInvitationError }
> {
  const normalisedEmail = input.email.trim().toLowerCase();
  const role: InviteRole = input.role ?? "user";

  // Pre-flight: is this email already a member of the tenant? `users` is
  // FORCE RLS so this lookup must run inside the tenant context.
  //
  // This pre-flight runs in a DIFFERENT tx from the actual insert below.
  // A concurrent admin inserting a `users` row for the same `(org_id, email)`
  // between the two txs could slip past this check — but the worst case is
  // a redundant invitation row, since the accept-path upsert is idempotent
  // on `(users.org_id, users.email)`. Treating this as a UX hint, not an
  // authorisation gate (data review F-A).
  const existingUser = await withTenantContext(input.orgId, async (tx) => {
    const [row] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.orgId, input.orgId), sql`lower(${users.email}) = ${normalisedEmail}`))
      .limit(1);
    return row;
  });
  if (existingUser) {
    return { ok: false, error: { kind: "already_member" } };
  }

  const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);

  const result = await withTenantContext(input.orgId, async (tx) => {
    // Resolve inviter's `users.id` — `invitedById` references the
    // application user, not the KC subject. The first super_admin seeding
    // path (`inviteFirstEnterpriseUser`) leaves `invitedById = null`, so
    // missing rows are tolerated.
    const [inviter] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.keycloakId, input.inviterKeycloakId), eq(users.orgId, input.orgId)))
      .limit(1);

    // Reuse a still-pending invitation rather than fan out a duplicate. We
    // surface this as a 409 from the route so the operator gets a clear
    // signal that they already invited this person; the dedicated
    // resend endpoint is the right way to retry.
    const [pending] = await tx
      .select({ id: invitations.id, expiresAt: invitations.expiresAt })
      .from(invitations)
      .where(
        and(
          eq(invitations.orgId, input.orgId),
          sql`lower(${invitations.email}) = ${normalisedEmail}`,
          eq(invitations.purpose, "team_invite"),
          isNull(invitations.acceptedAt),
        ),
      )
      .limit(1);
    if (pending && pending.expiresAt > new Date()) {
      return { ok: false as const, error: { kind: "already_invited" as const } };
    }

    const [row] = await tx
      .insert(invitations)
      .values({
        orgId: input.orgId,
        email: normalisedEmail,
        role,
        invitedById: inviter?.id ?? null,
        purpose: "team_invite",
        expiresAt,
      })
      .returning({
        id: invitations.id,
        orgId: invitations.orgId,
        email: invitations.email,
        role: invitations.role,
        invitedById: invitations.invitedById,
        acceptedAt: invitations.acceptedAt,
        expiresAt: invitations.expiresAt,
        createdAt: invitations.createdAt,
      });
    // biome-ignore lint/style/noNonNullAssertion: returning() always yields one row
    const invite = row!;

    // SEC-7: never put the raw token in the outbox; the worker looks it up
    // by invitation id inside its own trust boundary. Issue #153: stamp
    // `locale` (BCP-47) resolved from the 3-layer chain so the worker
    // picks the right template without reading other rows. The chain
    // checks `users.locale` first (re-invite of an existing teammate
    // honours their stored preference) and falls back to the tenant
    // default — see `resolveInviteeLocale`.
    const { locale } = await resolveInviteeLocale(tx, input.orgId, invite.email);
    await tx.insert(outboxEvents).values({
      tenantId: input.orgId,
      type: "invitation.created",
      payload: {
        tenantId: input.orgId,
        invitationId: invite.id,
        email: invite.email,
        role: invite.role,
        inviterUserId: inviter?.id ?? null,
        expiresAt: invite.expiresAt.toISOString(),
        locale,
      },
    });

    await tx.insert(auditLogs).values({
      orgId: input.orgId,
      userId: inviter?.id ?? null,
      action: "invitation.created",
      resourceType: "invitation",
      resourceId: invite.id,
      // No raw email in audit — the redact list masks it but we also
      // omit it here so a missing redact rule can't leak PII via audit
      // export. The invitation id is enough to reconstruct the row.
      newValues: { role: invite.role, purpose: "team_invite" },
      ipHash: input.ipHash,
      userAgent: input.userAgent,
    });

    return { ok: true as const, data: invite };
  });

  return result;
}

// ─── List ───────────────────────────────────────────────────────────────────

export interface ListInvitationsInput {
  orgId: string;
  page?: number;
  perPage?: number;
}

export interface InvitationSummary {
  id: string;
  orgId: string;
  email: string;
  role: InviteRole;
  invitedById: string | null;
  /**
   * Display name of the inviter ("First Last"), or null when the inviter
   * row no longer exists (FK is `ON DELETE SET NULL`) or the invitation
   * was created by the super-admin seeding path with `invitedById = null`.
   */
  invitedByName: string | null;
  acceptedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  /** Derived: pending | accepted | expired. */
  status: "pending" | "accepted" | "expired";
}

export interface ListInvitationsResult {
  data: InvitationSummary[];
  pagination: { page: number; perPage: number; total: number; totalPages: number };
}

/**
 * Paginated list of `team_invite` invitations for the current tenant.
 *
 * The route filters by purpose so the members page never surfaces self-
 * serve `signup_verification` rows; those belong to the signup flow and
 * leak the raw email of the original signup admin, who may have intended
 * the inbox shared with someone other than the team-invite UI shows.
 */
export async function listTeamInvitations(
  input: ListInvitationsInput,
): Promise<ListInvitationsResult> {
  const page = input.page ?? 1;
  const perPage = input.perPage ?? 20;
  const offset = (page - 1) * perPage;

  const now = new Date();
  return withTenantContext(input.orgId, async (tx) => {
    // Left join to `users` so the members page can show "Invited by Alice"
    // without a second round-trip. `invited_by_id` is nullable (super-admin
    // seeding path leaves it null) and the FK is `ON DELETE SET NULL`, so
    // the join must tolerate both a missing FK and a deleted inviter — left
    // join + null-safe formatting below covers both cases. Both tables are
    // scoped to the same tenant via FORCE RLS, so the join is naturally
    // tenant-scoped under `withTenantContext`.
    const rows = await tx
      .select({
        id: invitations.id,
        orgId: invitations.orgId,
        email: invitations.email,
        role: invitations.role,
        invitedById: invitations.invitedById,
        inviterFirstName: users.firstName,
        inviterLastName: users.lastName,
        acceptedAt: invitations.acceptedAt,
        expiresAt: invitations.expiresAt,
        createdAt: invitations.createdAt,
      })
      .from(invitations)
      .leftJoin(users, eq(users.id, invitations.invitedById))
      .where(and(eq(invitations.orgId, input.orgId), eq(invitations.purpose, "team_invite")))
      .orderBy(desc(invitations.createdAt))
      .limit(perPage)
      .offset(offset);

    const totalRows = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(invitations)
      .where(and(eq(invitations.orgId, input.orgId), eq(invitations.purpose, "team_invite")));
    const total = Number(totalRows[0]?.total ?? 0);

    const data: InvitationSummary[] = rows.map((r) => {
      const inviterName =
        r.inviterFirstName || r.inviterLastName
          ? `${r.inviterFirstName ?? ""} ${r.inviterLastName ?? ""}`.trim()
          : null;
      return {
        id: r.id,
        orgId: r.orgId,
        email: r.email,
        role: r.role as InviteRole,
        invitedById: r.invitedById,
        invitedByName: inviterName,
        acceptedAt: r.acceptedAt,
        expiresAt: r.expiresAt,
        createdAt: r.createdAt,
        status: r.acceptedAt
          ? ("accepted" as const)
          : r.expiresAt < now
            ? ("expired" as const)
            : ("pending" as const),
      };
    });

    return {
      data,
      pagination: {
        page,
        perPage,
        total,
        totalPages: Math.max(1, Math.ceil(total / perPage)),
      },
    };
  });
}

// ─── Revoke ─────────────────────────────────────────────────────────────────

export interface RevokeInvitationInput {
  orgId: string;
  invitationId: string;
  actorKeycloakId: string;
  ipHash?: string;
  userAgent?: string;
}

export type RevokeInvitationResult =
  | { ok: true }
  | { ok: false; error: "not_found" | "already_accepted" };

/**
 * Revoke a pending team invitation.
 *
 * Implemented as a hard DELETE — there is no "revoked" lifecycle state on
 * the row. This prevents an invitee clicking an old link from getting any
 * row back at all (the accept route 404s, which the route maps to a
 * generic 410). Soft-delete (a `revokedAt` column) was rejected: the
 * accept lookup already filters on `acceptedAt IS NULL`, so a soft-deleted
 * row would still match unless we added another column to the WHERE; a
 * second filter is one more thing to forget on an audit query.
 */
export async function revokeTeamInvitation(
  input: RevokeInvitationInput,
): Promise<RevokeInvitationResult> {
  return withTenantContext(input.orgId, async (tx) => {
    const [row] = await tx
      .select({ id: invitations.id, acceptedAt: invitations.acceptedAt, email: invitations.email })
      .from(invitations)
      .where(
        and(
          eq(invitations.id, input.invitationId),
          eq(invitations.orgId, input.orgId),
          eq(invitations.purpose, "team_invite"),
        ),
      )
      .limit(1);

    if (!row) return { ok: false as const, error: "not_found" as const };
    if (row.acceptedAt) {
      return { ok: false as const, error: "already_accepted" as const };
    }

    const [actor] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.keycloakId, input.actorKeycloakId), eq(users.orgId, input.orgId)))
      .limit(1);

    await tx.delete(invitations).where(eq(invitations.id, input.invitationId));

    await tx.insert(auditLogs).values({
      orgId: input.orgId,
      userId: actor?.id ?? null,
      action: "invitation.revoked",
      resourceType: "invitation",
      resourceId: input.invitationId,
      newValues: { revoked: true },
      ipHash: input.ipHash,
      userAgent: input.userAgent,
    });

    return { ok: true as const };
  });
}

// ─── Resend ─────────────────────────────────────────────────────────────────

export interface ResendInvitationInput {
  orgId: string;
  invitationId: string;
  actorKeycloakId: string;
  ipHash?: string;
  userAgent?: string;
}

export type ResendInvitationResult =
  | { ok: true; data: { id: string; expiresAt: Date } }
  | { ok: false; error: "not_found" | "already_accepted" };

/**
 * Rotate the token + expiry on a pending invitation and re-emit the
 * delivery event. The previous token is invalidated by virtue of the
 * `invitations.token` column being a UNIQUE constraint we overwrite.
 *
 * Always rotates the token (even if the existing one hasn't expired)
 * because the most common reason for a resend is "the original email
 * never arrived" — if the invitee only just received the original and
 * the operator clicks resend in parallel, we want only the most recent
 * link to be live to keep audit trails unambiguous.
 */
export async function resendTeamInvitation(
  input: ResendInvitationInput,
): Promise<ResendInvitationResult> {
  return withTenantContext(input.orgId, async (tx) => {
    const [row] = await tx
      .select({
        id: invitations.id,
        acceptedAt: invitations.acceptedAt,
        email: invitations.email,
        role: invitations.role,
      })
      .from(invitations)
      .where(
        and(
          eq(invitations.id, input.invitationId),
          eq(invitations.orgId, input.orgId),
          eq(invitations.purpose, "team_invite"),
        ),
      )
      .limit(1);

    if (!row) return { ok: false as const, error: "not_found" as const };
    if (row.acceptedAt) {
      return { ok: false as const, error: "already_accepted" as const };
    }

    const newToken = randomUUID();
    const expiresAt = new Date(Date.now() + RESEND_TTL_DAYS * 24 * 60 * 60 * 1000);

    await tx
      .update(invitations)
      .set({ token: newToken, expiresAt })
      .where(eq(invitations.id, input.invitationId));

    const [actor] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.keycloakId, input.actorKeycloakId), eq(users.orgId, input.orgId)))
      .limit(1);

    const { locale } = await resolveInviteeLocale(tx, input.orgId, row.email);
    await tx.insert(outboxEvents).values({
      tenantId: input.orgId,
      type: "invitation.resent",
      payload: {
        tenantId: input.orgId,
        invitationId: row.id,
        email: row.email,
        role: row.role,
        inviterUserId: actor?.id ?? null,
        expiresAt: expiresAt.toISOString(),
        locale,
      },
    });

    await tx.insert(auditLogs).values({
      orgId: input.orgId,
      userId: actor?.id ?? null,
      action: "invitation.resent",
      resourceType: "invitation",
      resourceId: input.invitationId,
      newValues: { rotated: true },
      ipHash: input.ipHash,
      userAgent: input.userAgent,
    });

    return { ok: true as const, data: { id: row.id, expiresAt } };
  });
}

// ─── Accept ─────────────────────────────────────────────────────────────────

export interface AcceptInvitationInput {
  token: string;
  firstName: string;
  lastName: string;
  /**
   * Cleartext password the invitee picks on the accept form. Sent over TLS
   * to Keycloak as a non-temporary credential. Validated for length at the
   * route boundary; never logged.
   */
  password: string;
  /**
   * Optional BCP-47 locale picked at acceptance time (issue #153). Only
   * persisted to `users.locale` when it differs from the tenant's
   * `default_locale` — accepting the default leaves `users.locale` NULL
   * so subsequent tenant-default changes still apply to this user.
   */
  locale?: Locale;
  ipHash?: string;
  userAgent?: string;
}

export interface AcceptInvitationDeps {
  /** Override the Keycloak admin client — used by integration tests. */
  keycloakAdmin?: KeycloakAdminClient;
}

export type AcceptInvitationResult =
  | {
      ok: true;
      tenantId: string;
      userId: string;
      slug: string;
    }
  | { ok: false };

/**
 * Accept a team invitation: provision (or recover) the Keycloak user,
 * attach to the Organization, and bind `users.keycloak_id`.
 *
 * Mirrors `verifySignup` exactly — same FOR UPDATE serialisation, same
 * hijack-vs-recovery discriminator, same UUID preflight on the KC org id,
 * same outbox-dedup gating on the user upsert. The one Phase-1 difference
 * is that we don't flip a tenant's `status` here: the tenant is already
 * `active` (either via super-admin seeding or via a prior signup verify).
 */
export async function acceptTeamInvitation(
  input: AcceptInvitationInput,
  deps: AcceptInvitationDeps = {},
): Promise<AcceptInvitationResult> {
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  // Lazily resolve the KC admin client AFTER the invitation lookup so a
  // bogus / expired token doesn't 500 in environments where the KC admin
  // client isn't configured (e.g. unit tests of the route's RBAC plumbing
  // that never reach the KC step). The singleton throws if
  // KEYCLOAK_ADMIN_CLIENT_SECRET is unset.
  const resolveKcAdmin = (): KeycloakAdminClient => deps.keycloakAdmin ?? keycloakAdmin();

  try {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: mirrors verifySignup — pending-accept + two recovery half-states + outbox dedup must stay inside one tx for atomicity. Splitting is tracked as the same overnight follow-up.
    return await systemDb.transaction(async (tx) => {
      // FOR UPDATE so concurrent accepts serialise on the invitation row.
      // Under READ COMMITTED, a second waiter's SELECT FOR UPDATE re-reads
      // the row after the first commits, so the JS-side `acceptedAt` check
      // below correctly observes the post-commit state. The token IS the
      // security boundary on this unauthenticated route; anything that
      // doesn't match here returns a generic 410 (no status-code
      // enumeration oracle). (Data review F-C.)
      const [row] = await tx
        .select({
          invitationId: invitations.id,
          orgId: invitations.orgId,
          email: invitations.email,
          role: invitations.role,
          expiresAt: invitations.expiresAt,
          acceptedAt: invitations.acceptedAt,
          tenantName: tenants.name,
          tenantSlug: tenants.slug,
          keycloakOrgId: tenants.keycloakOrgId,
          // Issue #153: read default_locale here so we can decide whether
          // to persist `users.locale` (only when the invitee picked
          // something different from the tenant's default).
          tenantDefaultLocale: tenants.defaultLocale,
        })
        .from(invitations)
        .innerJoin(tenants, eq(invitations.orgId, tenants.id))
        .where(and(eq(invitations.token, input.token), eq(invitations.purpose, "team_invite")))
        .for("update")
        .limit(1);

      if (!row || row.acceptedAt || row.expiresAt < new Date()) {
        return { ok: false } as const;
      }

      // Only persist a personal override when the invitee picked a value
      // *different* from the tenant default. Accepting the default leaves
      // `users.locale = NULL` so subsequent tenant-default changes carry
      // through automatically. (Issue #153.)
      const tenantDefaultLocale: Locale = isSupportedLocale(row.tenantDefaultLocale)
        ? row.tenantDefaultLocale
        : APP_DEFAULT_LOCALE;
      const personalLocale: Locale | null =
        input.locale && isSupportedLocale(input.locale) && input.locale !== tenantDefaultLocale
          ? input.locale
          : null;

      // Resolve the KC admin client now that we know the row is valid —
      // the singleton throws if KEYCLOAK_ADMIN_CLIENT_SECRET is unset, so
      // doing this earlier would 500 the no-match path on an unstubbed
      // test env.
      const kcAdmin = resolveKcAdmin();

      await tx.execute(sql`SELECT set_config('app.current_organization_id', ${row.orgId}, true)`);

      // Get-or-create the tenant's Keycloak Organization. Enterprise
      // tenants seeded via the super-admin path before issue #114 don't
      // have a `keycloak_org_id` yet — same idempotent shape as
      // verifySignup uses to recover from a half-failed signup.
      let kcOrgId = row.keycloakOrgId;
      if (!kcOrgId) {
        try {
          const created = await kcAdmin.createOrganization({
            name: row.tenantName,
            alias: row.tenantSlug,
            attributes: { org_id: [row.orgId] },
          });
          kcOrgId = created.id;
        } catch (err) {
          if (err instanceof KeycloakAdminError && err.status === 409) {
            // Recovery: a prior call created the Org but the DB tx rolled
            // back. Adopt only if its `org_id` attribute proves it belongs
            // to THIS tenant — slugs are globally unique in our DB, so the
            // only legit alias collision is our own prior crash.
            const existing = await kcAdmin.getOrganizationByAlias(row.tenantSlug);
            const existingOrgId = existing?.attributes?.org_id?.[0];
            if (!existing || existingOrgId !== row.orgId) {
              throw err;
            }
            kcOrgId = existing.id;
          } else {
            throw err;
          }
        }
        if (!UUID_RE.test(kcOrgId)) {
          throw new Error(`Keycloak organization id is not a UUID: ${kcOrgId}`);
        }
        await tx
          .update(tenants)
          .set({ keycloakOrgId: kcOrgId, updatedAt: new Date() })
          .where(eq(tenants.id, row.orgId));
      }

      // Hijack discriminator — see header comment. Read DB state before
      // any KC call. Email match uses lower(...) on both sides as
      // defence-in-depth: `invitations.email` is normalised lowercase at
      // INSERT (createTeamInvitation, signup()), but `users.email` has no
      // schema-level case-folding constraint, so a historical mixed-case
      // import or manual support write could otherwise miss the match
      // and fall through to the createUser path → 409 → spurious 410.
      // (Data review F-E.)
      const [existingUserRow] = await tx
        .select({ keycloakId: users.keycloakId })
        .from(users)
        .where(and(eq(users.orgId, row.orgId), sql`lower(${users.email}) = lower(${row.email})`))
        .limit(1);
      const existingKcId = existingUserRow?.keycloakId ?? null;

      let kcUserId: string;
      if (existingKcId) {
        // Legitimate recovery — we own this KC user. Reset password to
        // whatever the invitee just typed (forgot-password semantics, with
        // the invitation token as the proof of inbox control), patch
        // attributes idempotently. Role attribute is sourced from the
        // invitation row, NOT from the existing users row, so an admin
        // updating a stale invitation's role before the invitee accepts
        // produces the right JWT claims downstream.
        await kcAdmin.resetUserPassword(existingKcId, input.password);
        await kcAdmin.setUserAttributes(existingKcId, {
          org_id: [row.orgId],
          role: [row.role],
        });
        kcUserId = existingKcId;
      } else {
        // First binding for this email under this tenant. 409 here means
        // the email belongs to a realm user we do NOT own — surface as a
        // generic 410 with a `team_invite.kc_user_exists` warn for SRE.
        const created = await kcAdmin.createUser({
          email: row.email,
          firstName,
          lastName,
          password: input.password,
          // Token possession proves inbox control — flag as verified so KC
          // doesn't ask the invitee for another round.
          emailVerified: true,
          attributes: { org_id: [row.orgId], role: [row.role] },
        });
        kcUserId = created.id;
      }

      try {
        await kcAdmin.attachUserToOrg(kcOrgId, kcUserId);
      } catch (err) {
        if (!(err instanceof KeycloakAdminError && err.status === 409)) {
          throw err;
        }
        // 409 = already a member (recovery path). Treat as success.
      }

      // Upsert the users row. `RETURNING (xmax = 0) AS inserted` lets us
      // gate the `user.invited_accepted` outbox event so a recovery re-run
      // doesn't re-fire the welcome consumer.
      const upsertResult = await tx
        .insert(users)
        .values({
          orgId: row.orgId,
          email: row.email,
          firstName,
          lastName,
          role: row.role,
          keycloakId: kcUserId,
          // Issue #153: write the personal locale only on first INSERT.
          // The recovery branch (UPDATE) below explicitly omits `locale`
          // from the SET clause, which has two intended consequences:
          //   1. A user who already chose a personal locale earlier and
          //      hits the recovery path keeps their preference (we never
          //      clobber a chosen value).
          //   2. A recovery-state user with `locale = NULL` cannot set
          //      their personal preference via the accept form — they
          //      must use the (future) /settings/profile switcher
          //      (issue #159) instead.
          // Both behaviours are deliberate; security review F-S2.
          locale: personalLocale,
        })
        .onConflictDoUpdate({
          target: [users.orgId, users.email],
          set: {
            firstName,
            lastName,
            keycloakId: kcUserId,
            // Don't downgrade an existing user's role on recovery — the
            // invitation may carry a stale role from before an admin
            // promoted them through another path.
            role: row.role,
            updatedAt: new Date(),
          },
        })
        .returning({ id: users.id, inserted: sql<boolean>`(xmax = 0)` });
      // biome-ignore lint/style/noNonNullAssertion: insert/upsert returning() yields one row
      const u = upsertResult[0]!;
      const userWasInserted = u.inserted === true;

      // Mark accepted and gate outbox emission on the actual flip — a
      // recovery re-run lands here with `acceptedAt` already set above
      // (no, the FOR UPDATE filter rejected it) so this UPDATE always
      // moves a row, but the user-side dedup is still important.
      await tx
        .update(invitations)
        .set({ acceptedAt: new Date() })
        .where(eq(invitations.id, row.invitationId));

      const eventsToEmit: Array<{
        tenantId: string;
        type: string;
        payload: Record<string, unknown>;
      }> = [
        {
          tenantId: row.orgId,
          type: "invitation.accepted",
          payload: {
            tenantId: row.orgId,
            invitationId: row.invitationId,
            userId: u.id,
            role: row.role,
          },
        },
      ];
      if (userWasInserted) {
        eventsToEmit.push({
          tenantId: row.orgId,
          type: "user.invited_accepted",
          payload: {
            tenantId: row.orgId,
            userId: u.id,
            role: row.role,
            firstAdmin: false,
          },
        });
      }
      await tx.insert(outboxEvents).values(eventsToEmit);

      await tx.insert(auditLogs).values({
        orgId: row.orgId,
        userId: u.id,
        action: "invitation.accepted",
        resourceType: "invitation",
        resourceId: row.invitationId,
        newValues: { role: row.role, userId: u.id },
        ipHash: input.ipHash,
        userAgent: input.userAgent,
      });

      return {
        ok: true as const,
        tenantId: row.orgId,
        userId: u.id,
        slug: row.tenantSlug,
      };
    });
  } catch (err) {
    if (err instanceof KeycloakUserExistsError) {
      log.warn({ event: "team_invite.kc_user_exists" }, "accept rejected — KC user already exists");
      return { ok: false };
    }
    throw err;
  }
}

// ─── Pre-flight visibility for the route ────────────────────────────────────

/**
 * Look up an invitation by id without tenant context — used by the route
 * to assert the row exists in the same tenant as the authenticated
 * org_admin before touching anything. Returns null when the row doesn't
 * exist or doesn't belong to the caller's tenant.
 */
export async function getTeamInvitationForOrg(
  orgId: string,
  invitationId: string,
): Promise<{ id: string; email: string; role: InviteRole; acceptedAt: Date | null } | null> {
  return withTenantContext(orgId, async (tx) => {
    const [row] = await tx
      .select({
        id: invitations.id,
        email: invitations.email,
        role: invitations.role,
        acceptedAt: invitations.acceptedAt,
      })
      .from(invitations)
      .where(
        and(
          eq(invitations.id, invitationId),
          eq(invitations.orgId, orgId),
          eq(invitations.purpose, "team_invite"),
        ),
      )
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      role: row.role as InviteRole,
      acceptedAt: row.acceptedAt,
    };
  });
}

// ─── Public probe (PR #154 follow-up) ──────────────────────────────────────

/**
 * Result of `probeTeamInvitation`. Either the token is valid and we hand
 * back the tenant's `default_locale` so the accept form can pre-select
 * the right value (issue #153), or the probe fails — the route maps
 * `null` to a generic 410. (We deliberately don't expose any other
 * tenant identifiers here; the slug/name leak via the post-accept
 * redirect already, but the probe response stays minimal.)
 */
export type ProbeTeamInvitationResult = { ok: true; tenantDefaultLocale: Locale } | null;

/**
 * Public, side-effect-free check that a token is currently acceptable.
 *
 * The /invite/accept page calls this on load so an invitee with a dead
 * link is shown the terminal error screen immediately, rather than
 * filling out a 4-field form to discover the same thing on submit. The
 * response also carries the tenant's `default_locale` so the form can
 * pre-select the right locale picker option (issue #153).
 *
 * Anti-enumeration: the route translates `null` into a generic 410, so
 * "wrong token" / "already accepted" / "expired" / "wrong purpose" all
 * collapse to the same response. Only the success branch is serialised
 * to the caller. Same shape the accept endpoint enforces (cf.
 * `acceptTeamInvitation`).
 *
 * Owner-role connection (`systemDb`) because the caller is unauthenticated
 * and there's no tenant context to set on the app role. The token IS the
 * security boundary; RLS adds no value here.
 *
 * Note: a token that probes "valid" can still race a concurrent accept /
 * resend / revoke before the user submits — the post-submit terminal
 * screen on the page handles that case.
 */
export async function probeTeamInvitation(token: string): Promise<ProbeTeamInvitationResult> {
  // Cheap shape guard — the route schema also rejects malformed tokens
  // with a 400, but a defensive check here keeps the function safe to
  // call from anywhere without leaking error shape.
  if (typeof token !== "string" || token.length === 0) return null;

  const [row] = await systemDb
    .select({
      acceptedAt: invitations.acceptedAt,
      expiresAt: invitations.expiresAt,
      tenantDefaultLocale: tenants.defaultLocale,
    })
    .from(invitations)
    .innerJoin(tenants, eq(invitations.orgId, tenants.id))
    .where(and(eq(invitations.token, token), eq(invitations.purpose, "team_invite")))
    .limit(1);
  if (!row) return null;
  if (row.acceptedAt) return null;
  if (row.expiresAt < new Date()) return null;
  const tenantDefaultLocale: Locale = isSupportedLocale(row.tenantDefaultLocale)
    ? row.tenantDefaultLocale
    : APP_DEFAULT_LOCALE;
  return { ok: true, tenantDefaultLocale };
}
