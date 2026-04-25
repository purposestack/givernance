/**
 * Self-serve signup service (issue #108 / ADR-016).
 *
 * Four endpoints + a cleanup cron, with audit + outbox emission at every
 * state transition. The verify endpoint is now the integration boundary
 * for Keycloak provisioning (issue #114 shipped) — it gets-or-creates a
 * Keycloak Organization for the tenant, gets-or-creates a realm user
 * with the chosen password, and attaches the user as a member. All KC
 * orchestration is idempotent across the three half-states the recovery
 * resend can hand it back in:
 *
 *   1. **Pending verify** — tenant `provisional`, no `users` row yet,
 *      no KC artefacts. The straight first-time path.
 *   2. **No KC credential** — tenant `active`, `users` row exists with
 *      `keycloak_id IS NULL`, no Org. Recovery: createOrganization +
 *      createUser + attach + upsert the users row.
 *   3. **No KC Organization** — tenant `active`, `users` row has
 *      `keycloak_id` set, but `tenant.keycloak_org_id IS NULL`. Recovery:
 *      createOrganization + reset existing user's password + set
 *      attributes + attach. createUser is SKIPPED — we own the existing
 *      KC user via the durable `users.keycloak_id` binding, so this is
 *      forgot-password semantics, NOT a takeover of someone else's
 *      credential.
 *
 * The discriminator between "legitimate recovery" and "hijack attempt"
 * is `users.keycloak_id` — read in the verify tx before any KC call.
 * If it's set, we own that KC user and may safely re-bind. If it's
 * null and KC reports the email exists (409 on createUser), we throw
 * `KeycloakUserExistsError` and the route surfaces a generic 410 (no
 * enumeration oracle), with an `signup.kc_user_exists` warn log for
 * SRE.
 *
 * Review history:
 *  - SEC-1 / DATA-3 (PR #117): invitations carry `purpose='signup_
 *    verification'`; team-invite endpoint filters to `purpose='team_
 *    invite'`.
 *  - SEC-5 / ENG-4: slug / domain conflicts → 409, single generic
 *    "Signup could not be completed".
 *  - SEC-6: verify collapses "expired" / "already verified" / "unknown
 *    token" / "kc user exists" / "first_admin race" into one 410.
 *  - SEC-7: outbox payload + audit newValues never carry the raw
 *    verification token; the email worker looks it up by invitation id.
 *  - DATA-1: 23505 unique violations on slug/domain → 409, not 500.
 *  - DATA-2: `email_in_use` triggers when a `users.email` row exists in
 *    any tenant.
 *  - DATA-7: `cleanupUnverifiedTenants` re-asserts invariants inside
 *    the DELETE's WHERE (atomic with any concurrent verify).
 *  - PR #143 review: KC org-adoption requires `org_id` attribute match;
 *    KC user-create 409 fails loud (no silent takeover); outbox events
 *    gated on actual state changes (no duplicate `tenant.verified` or
 *    `user.jit_provisioned` on recovery re-runs); resend payload
 *    carries `country` recovered from the original requested-event for
 *    EN/FR template selection.
 */

import { randomUUID } from "node:crypto";
import { isPersonalEmailDomain, PINO_REDACT_PATHS } from "@givernance/shared/constants";
import {
  auditLogs,
  invitations,
  outboxEvents,
  type TenantStatus,
  tenantDomains,
  tenants,
  users,
} from "@givernance/shared/schema";
import { validateTenantSlug } from "@givernance/shared/validators";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import pino from "pino";
import { db, systemDb } from "../../lib/db.js";
import {
  type KeycloakAdminClient,
  KeycloakAdminError,
  KeycloakUserExistsError,
  keycloakAdmin,
} from "../../lib/keycloak-admin.js";

/**
 * Postgres UUID v4 shape — mirrors the `tenants_keycloak_org_id_uuid_chk`
 * CHECK constraint. We validate any id we receive from Keycloak before
 * binding it to a tenant row so a misconfigured proxy or future KC version
 * that hands back a non-UUID id (ULID, opaque string) is caught BEFORE the
 * tx attempts the UPDATE — otherwise the UPDATE 23514s, the verify rolls
 * back, and the KC-side org+user+membership orphan with no recovery path.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Module-scoped logger. The module's hot paths are unauthenticated public
 * routes that hand-roll their tx + KC orchestration outside any
 * Fastify request context (e.g. the cleanup cron, the worker re-entries),
 * so a Fastify-bound `request.log` isn't always available. PII is masked
 * via the same redact list every other service uses.
 */
const log = pino({
  name: "signup-service",
  redact: { paths: [...PINO_REDACT_PATHS], censor: "[REDACTED]" },
});

const PROVISIONAL_GRACE_DAYS = 7;
const VERIFICATION_TTL_HOURS = 24;

export type SignupError =
  | { kind: "invalid_slug"; reason: "syntax" | "reserved" | "punycode" }
  | { kind: "conflict"; hint: "slug_taken" | "email_in_use" };

export type SignupResult =
  | { ok: true; tenantId: string; email: string; verificationToken: string }
  | { ok: false; error: SignupError };

export interface SignupInput {
  orgName: string;
  slug: string;
  firstName: string;
  lastName: string;
  email: string;
  country?: string;
  ipHash?: string;
  userAgent?: string;
}

/**
 * Normalise a domain: lowercase + IDN-canonical via URL parsing (Node's
 * built-in IDNA). Returns `null` if the input cannot be resolved — the
 * caller treats that as validation failure. (SEC-11)
 */
function normaliseDomain(domain: string): string | null {
  try {
    return new URL(`https://${domain.trim().toLowerCase()}/`).hostname;
  } catch {
    return null;
  }
}

/** Split an email into local / domain. Returns `null` on a trivially invalid value. */
function splitEmail(email: string): { local: string; domain: string } | null {
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) return null;
  const domain = normaliseDomain(email.slice(at + 1));
  if (!domain) return null;
  return { local: email.slice(0, at).toLowerCase(), domain };
}

/** 122-bit random token — stored as the `invitations.token` uuid. */
function generateVerificationToken(): string {
  return randomUUID();
}

/** Is the given error a Postgres unique-violation (23505)? */
function isUniqueViolation(err: unknown, constraintHint?: RegExp): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; constraint?: string; message?: string };
  if (e.code !== "23505") return false;
  if (!constraintHint) return true;
  return constraintHint.test(e.constraint ?? "") || constraintHint.test(e.message ?? "");
}

// ─── Signup ─────────────────────────────────────────────────────────────────

export async function signup(input: SignupInput): Promise<SignupResult> {
  const parsedEmail = splitEmail(input.email);
  if (!parsedEmail) {
    // Malformed email slipped past the route validator — treat as a generic
    // conflict rather than introducing a new distinct error code.
    return { ok: false, error: { kind: "conflict", hint: "email_in_use" } };
  }
  const normalisedEmail = input.email.trim().toLowerCase();
  const normalisedOrgName = input.orgName.trim().normalize("NFC");

  const slugCheck = validateTenantSlug(input.slug);
  if (!slugCheck.ok) {
    return { ok: false, error: { kind: "invalid_slug", reason: slugCheck.reason } };
  }
  const canonicalSlug = slugCheck.slug;

  // Preflight: existing-slug short-circuit. The INSERT below also has the
  // UNIQUE constraint for race safety (see catch on 23505).
  const [existingSlug] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, canonicalSlug))
    .limit(1);
  if (existingSlug) {
    return { ok: false, error: { kind: "conflict", hint: "slug_taken" } };
  }

  // Existing-user short-circuit: if the email already belongs to a user in
  // any tenant, surface `email_in_use` rather than creating a duplicate
  // provisional row that would 23505 at Keycloak-bind time (DATA-2).
  const [existingUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${normalisedEmail}`)
    .limit(1);
  if (existingUser) {
    return { ok: false, error: { kind: "conflict", hint: "email_in_use" } };
  }

  // Domain-already-claimed check (enterprise tenants). Skipped for personal-
  // email domains.
  if (!isPersonalEmailDomain(parsedEmail.domain)) {
    const [claimedDomain] = await db
      .select({ orgId: tenantDomains.orgId })
      .from(tenantDomains)
      .where(and(eq(tenantDomains.domain, parsedEmail.domain), eq(tenantDomains.state, "verified")))
      .limit(1);
    if (claimedDomain) {
      return { ok: false, error: { kind: "conflict", hint: "email_in_use" } };
    }
  }

  const token = generateVerificationToken();
  const expiresAt = new Date(Date.now() + VERIFICATION_TTL_HOURS * 60 * 60 * 1000);

  try {
    const result = await db.transaction(async (tx) => {
      const [tenant] = await tx
        .insert(tenants)
        .values({
          name: normalisedOrgName,
          slug: canonicalSlug,
          status: "provisional" as TenantStatus,
          createdVia: "self_serve",
        })
        .returning({ id: tenants.id });

      // biome-ignore lint/style/noNonNullAssertion: returning() always yields one row
      const t = tenant!;

      await tx.execute(sql`SELECT set_config('app.current_organization_id', ${t.id}, true)`);

      const [invitation] = await tx
        .insert(invitations)
        .values({
          orgId: t.id,
          email: normalisedEmail,
          role: "org_admin",
          token,
          purpose: "signup_verification",
          expiresAt,
        })
        .returning({ id: invitations.id });
      // biome-ignore lint/style/noNonNullAssertion: returning() always yields one row
      const invitationId = invitation!.id;

      await tx.insert(outboxEvents).values([
        {
          tenantId: t.id,
          type: "tenant.self_signup_started",
          payload: {
            tenantId: t.id,
            slug: canonicalSlug,
            emailDomain: parsedEmail.domain,
            country: input.country,
          },
        },
        {
          tenantId: t.id,
          type: "tenant.signup_verification_requested",
          payload: {
            // SEC-7: no raw token in the outbox. The email worker looks up
            // the token by invitation id inside its own transaction.
            tenantId: t.id,
            invitationId,
            expiresAt: expiresAt.toISOString(),
            country: input.country,
          },
        },
      ]);

      await tx.insert(auditLogs).values({
        orgId: t.id,
        userId: null,
        action: "tenant.self_signup_started",
        resourceType: "tenant",
        resourceId: t.id,
        newValues: {
          slug: canonicalSlug,
          emailDomain: parsedEmail.domain,
          country: input.country,
        },
        ipHash: input.ipHash,
        userAgent: input.userAgent,
      });

      return t.id;
    });

    return {
      ok: true,
      tenantId: result,
      email: normalisedEmail,
      verificationToken: token,
    };
  } catch (err) {
    if (isUniqueViolation(err, /tenants_slug/)) {
      return { ok: false, error: { kind: "conflict", hint: "slug_taken" } };
    }
    if (isUniqueViolation(err, /users|invitations_token/)) {
      return { ok: false, error: { kind: "conflict", hint: "email_in_use" } };
    }
    throw err;
  }
}

// ─── Resend verification ────────────────────────────────────────────────────

export type ResendResult =
  | { ok: true; tenantId: string; email: string; verificationToken: string }
  | { ok: false };

/**
 * Re-emit a verification token. Matches three recoverable states so a
 * half-failed signup isn't a dead-end:
 *
 *  1. **Pending verify.** Tenant `provisional`, invitation not yet accepted —
 *     the original happy-path resend.
 *  2. **No Keycloak credential yet.** Tenant `active` but the user's
 *     `keycloak_id` is NULL — what self-serve signups looked like before
 *     the verify endpoint started provisioning the Keycloak user.
 *  3. **No Keycloak Organization yet.** Tenant `active`, user has a
 *     `keycloak_id`, but `tenant.keycloak_org_id` is NULL — what they look
 *     like after the credential-only fix landed but before the Organization
 *     wiring did. Without an Org the realm's user-attribute mapper has no
 *     `org_id` to emit and the web auth callback bounces with
 *     `missing_org_id`.
 *
 * Cases (2) and (3) both resolve by clearing `acceptedAt` on the latest
 * `signup_verification` invitation and letting the next verify call run —
 * `verifySignup` is idempotent for every step (org get-or-create, user
 * create-or-update with attribute merge, member attach with 409 swallow).
 *
 * Silently returns `{ok: false}` for everything else (fully-bound users,
 * unknown emails) — the route always responds 204 so this cannot be used
 * as an email-enumeration oracle.
 */
export async function resendVerification(email: string): Promise<ResendResult> {
  const normalised = email.trim().toLowerCase();

  // Owner role: same justification as verifySignup — no org context yet, and
  // the app role would have RLS filter the invitation join to zero rows.
  // Match all recoverable states in one query, ordered so a still-valid
  // pending invitation wins over an older half-provisioned row.
  // Case-insensitive email join: `invitations.email` is normalised
  // lowercase at INSERT (signup() / resend()), but `users.email` has no
  // schema-level case-folding constraint. Mixed-case future writes to
  // users.email would silently break this join under `eq(...)`. Compare
  // both sides via lower() so the recovery match stays robust.
  const rows = await systemDb
    .select({
      tenantId: tenants.id,
      status: tenants.status,
      invitationId: invitations.id,
      invitationToken: invitations.token,
      expiresAt: invitations.expiresAt,
      createdAt: invitations.createdAt,
    })
    .from(invitations)
    .innerJoin(tenants, eq(invitations.orgId, tenants.id))
    .leftJoin(
      users,
      and(
        eq(users.orgId, invitations.orgId),
        sql`lower(${users.email}) = lower(${invitations.email})`,
      ),
    )
    .where(
      and(
        eq(invitations.email, normalised),
        eq(invitations.purpose, "signup_verification"),
        eq(tenants.createdVia, "self_serve"),
        sql`(
          (${tenants.status} = 'provisional' AND ${invitations.acceptedAt} IS NULL)
          OR
          (${tenants.status} = 'active'
            AND (${users.keycloakId} IS NULL OR ${tenants.keycloakOrgId} IS NULL))
        )`,
      ),
    )
    .orderBy(sql`${invitations.createdAt} DESC`)
    .limit(1);

  if (rows.length === 0) {
    log.info({ event: "signup.resend", matched: false }, "resend silent no-match");
    return { ok: false };
  }

  const row = rows[0];
  if (!row) return { ok: false };

  // Recover the original signup country so the worker picks the right
  // EN/FR template on resend. The `country` was emitted on the initial
  // `tenant.signup_verification_requested` payload (signup() emits it);
  // pull it from there rather than adding a schema column. Returns
  // undefined for tenants seeded before country was tracked or for
  // payloads that omitted it — worker falls back to its EN default.
  const [originalEvent] = await systemDb
    .select({ payload: outboxEvents.payload })
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.tenantId, row.tenantId),
        eq(outboxEvents.type, "tenant.signup_verification_requested"),
      ),
    )
    .orderBy(sql`${outboxEvents.createdAt} ASC`)
    .limit(1);
  const originalCountry =
    typeof originalEvent?.payload === "object" &&
    originalEvent.payload !== null &&
    "country" in originalEvent.payload &&
    typeof originalEvent.payload.country === "string"
      ? originalEvent.payload.country
      : undefined;

  const newToken = generateVerificationToken();
  const expiresAt = new Date(Date.now() + VERIFICATION_TTL_HOURS * 60 * 60 * 1000);

  await systemDb.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_organization_id', ${row.tenantId}, true)`);

    // Half-provisioned rows have `acceptedAt` set from the prior verify;
    // clearing it lets verifySignup's invitation-validity guard accept the
    // fresh token. The pre-existing audit_logs row preserves the original
    // acceptance event, so this isn't a history rewrite.
    await tx
      .update(invitations)
      .set({ token: newToken, expiresAt, acceptedAt: null })
      .where(eq(invitations.id, row.invitationId));

    await tx.insert(outboxEvents).values({
      tenantId: row.tenantId,
      type: "tenant.signup_verification_resent",
      payload: {
        tenantId: row.tenantId,
        invitationId: row.invitationId,
        expiresAt: expiresAt.toISOString(),
        ...(originalCountry ? { country: originalCountry } : {}),
      },
    });
  });

  log.info(
    { event: "signup.resend", matched: true, tenantId: row.tenantId, status: row.status },
    "resend rotated invitation token",
  );

  return { ok: true, tenantId: row.tenantId, email: normalised, verificationToken: newToken };
}

// ─── Verify ─────────────────────────────────────────────────────────────────

export type VerifyResult =
  | {
      ok: true;
      tenantId: string;
      userId: string;
      slug: string;
      provisionalUntil: string;
    }
  | { ok: false };

export interface VerifyInput {
  token: string;
  firstName: string;
  lastName: string;
  /**
   * Cleartext password the user picks on the verify form. Sent over TLS to
   * Keycloak as a non-temporary credential. Validated for length at the route
   * boundary; never logged.
   */
  password: string;
  ipHash?: string;
  userAgent?: string;
}

export interface VerifyDeps {
  /** Override the Keycloak admin client — used by integration tests. */
  keycloakAdmin?: KeycloakAdminClient;
}

export async function verifySignup(
  input: VerifyInput,
  deps: VerifyDeps = {},
): Promise<VerifyResult> {
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  const kcAdmin = deps.keycloakAdmin ?? keycloakAdmin();

  try {
    // Owner role: the verify request is unauthenticated, so we have no org
    // context to set before the SELECT — the app role would have RLS hide
    // the invitation row and we'd return ok:false for every valid token.
    // The unguessable token IS the security boundary here.
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: verifySignup orchestrates pending-verify + two recovery half-states inside one tx. Long-tx split is tracked as the overnight follow-up referenced in PR #143.
    return await systemDb.transaction(async (tx) => {
      // FOR UPDATE so concurrent verifies serialise on the invitation row
      // (ENG-9). If the invitation doesn't match, the caller gets a generic
      // 410 (no status-code enumeration oracle — SEC-6).
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
          tenantStatus: tenants.status,
          createdVia: tenants.createdVia,
          keycloakOrgId: tenants.keycloakOrgId,
        })
        .from(invitations)
        .innerJoin(tenants, eq(invitations.orgId, tenants.id))
        .where(
          and(
            eq(invitations.token, input.token),
            eq(invitations.purpose, "signup_verification"),
            eq(tenants.createdVia, "self_serve"),
          ),
        )
        .for("update")
        .limit(1);

      if (!row || row.acceptedAt || row.expiresAt < new Date()) {
        return { ok: false } as const;
      }

      const provisionalUntil = new Date(Date.now() + PROVISIONAL_GRACE_DAYS * 24 * 60 * 60 * 1000);

      await tx.execute(sql`SELECT set_config('app.current_organization_id', ${row.orgId}, true)`);

      // Only count this verify as "the one that flipped the tenant" if the
      // UPDATE actually moved it out of `provisional`. Recovery re-runs (the
      // tenant is already `active` from a prior partial success) get an
      // empty .returning() and we'll skip the `tenant.verified` outbox event
      // below — downstream consumers (welcome email, billing trial start,
      // analytics conversion) shouldn't receive duplicates.
      const flippedTenant = await tx
        .update(tenants)
        .set({
          status: "active",
          verifiedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(tenants.id, row.orgId),
            // Don't accidentally resurrect suspended/archived tenants.
            eq(tenants.status, "provisional"),
          ),
        )
        .returning({ id: tenants.id });
      const tenantWasFlipped = flippedTenant.length > 0;

      // Get-or-create the tenant's Keycloak Organization. The realm's JWT
      // mappers expect every member's token to carry a top-level `org_id`
      // claim sourced from the user attribute (see scripts/keycloak-sync-
      // realm.sh `oidc-usermodel-attribute-mapper`), and an `organization`
      // claim from membership. A self-serve user without an Organization
      // would land on /api/auth/callback with `missing_org_id` and bounce
      // back to /login.
      //
      // Idempotent for the recovery path: if a previous verify attempt
      // created the org but its keycloak_org_id never made it back into
      // the DB row (network glitch, KC 201 + DB rollback), we look up by
      // alias via the 409 catch.
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
            // Recovery: a prior verify attempt already created an Org with
            // this alias, then the DB tx rolled back. Adopt it ONLY if its
            // `org_id` attribute proves it belongs to THIS tenant. Without
            // this guard we'd silently inherit a stranger's Org (and any
            // members it carries) — those members' future logins would
            // emit an `organization` membership claim identifying our
            // tenant. Slugs are globally unique in our DB, so the only
            // legit alias collision is our own prior crash; an `org_id`
            // mismatch means manual KC tampering or a stale leftover and
            // we'd rather fail loud than adopt.
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
          // `tenants_keycloak_org_id_uuid_chk` enforces UUID shape; without
          // this preflight a non-UUID id (misconfigured proxy, hypothetical
          // future KC release using ULIDs) would 23514 the UPDATE below,
          // roll back the verify tx, and leak the just-created KC org +
          // user with no compensating delete.
          throw new Error(`Keycloak organization id is not a UUID: ${kcOrgId}`);
        }
        await tx
          .update(tenants)
          .set({ keycloakOrgId: kcOrgId, updatedAt: new Date() })
          .where(eq(tenants.id, row.orgId));
      }

      // Discriminate two scenarios that both surface as "KC user exists":
      //   (a) Legitimate recovery — a prior verify for THIS tenant + email
      //       already bound a KC user, recorded as `users.keycloak_id`.
      //       The operator just typed a new password on the recovery
      //       verify form and we should reset that KC user's password +
      //       refresh attributes (effectively a "forgot password via
      //       email link" with the verify token as the proof).
      //   (b) Hijack risk — no prior `users.keycloak_id` for this tenant
      //       + email exists, but KC says the email is taken. That means
      //       another principal owns the realm credential (the seeded
      //       super_admin, an enterprise-tenant user provisioned before
      //       JIT, manual KC creation). Proving inbox control is NOT
      //       authorisation to overwrite their credential.
      //
      // Look up the existing binding BEFORE touching KC so the decision
      // is based on durable DB state, not on KC-side guesswork.
      const [existingUserRow] = await tx
        .select({ keycloakId: users.keycloakId })
        .from(users)
        .where(and(eq(users.orgId, row.orgId), eq(users.email, row.email)))
        .limit(1);
      const existingKcId = existingUserRow?.keycloakId ?? null;

      let kcUserId: string;
      if (existingKcId) {
        // (a) Recovery — we own this KC user. Reset password to whatever
        // the operator typed on this verify form (forgot-password
        // semantics) and patch attributes idempotently.
        await kcAdmin.resetUserPassword(existingKcId, input.password);
        await kcAdmin.setUserAttributes(existingKcId, {
          org_id: [row.orgId],
          role: ["org_admin"],
        });
        kcUserId = existingKcId;
      } else {
        // (b) First binding — create. 409 here means the email belongs to
        // a realm user we do NOT own; createUser throws
        // `KeycloakUserExistsError` and the outer catch maps it to a
        // generic 410 (no enumeration oracle) plus a `signup.kc_user_exists`
        // warn for SRE.
        const created = await kcAdmin.createUser({
          email: row.email,
          firstName,
          lastName,
          password: input.password,
          // The verify token IS the email-ownership proof — flag the user
          // as verified so Keycloak doesn't ask for another round.
          emailVerified: true,
          attributes: { org_id: [row.orgId], role: ["org_admin"] },
        });
        kcUserId = created.id;
      }

      // Attach the user as a member of the Organization. 409 = already a
      // member (recovery path: prior verify created the membership but
      // failed before binding `keycloak_id` on the users row). Treat as
      // success.
      try {
        await kcAdmin.attachUserToOrg(kcOrgId, kcUserId);
      } catch (err) {
        if (!(err instanceof KeycloakAdminError && err.status === 409)) {
          throw err;
        }
      }

      // Upsert (target = the (org_id, email) unique index) so a verify
      // re-entry from a half-provisioned tenant — i.e. the resend flow
      // cleared `acceptedAt` after the original verify already wrote a
      // users row but couldn't bind a Keycloak credential — just patches
      // `keycloak_id` onto the existing row instead of failing on the
      // unique violation. `firstAdmin` and `provisional_until` are left
      // untouched on update so the original grace window stays put.
      // `RETURNING (xmax = 0) AS inserted` is the canonical Postgres trick
      // to distinguish an INSERT from an upsert-UPDATE — `xmax` is 0 only
      // on freshly-inserted rows. Drives the dedup logic on the
      // `user.jit_provisioned` outbox event below: a recovery re-run that
      // patches keycloak_id onto an existing row should NOT re-emit a
      // provisioning event downstream consumers will treat as new.
      const upsertResult = await tx
        .insert(users)
        .values({
          orgId: row.orgId,
          email: row.email,
          firstName,
          lastName,
          role: "org_admin",
          firstAdmin: true,
          keycloakId: kcUserId,
          provisionalUntil,
        })
        .onConflictDoUpdate({
          target: [users.orgId, users.email],
          set: {
            firstName,
            lastName,
            keycloakId: kcUserId,
            updatedAt: new Date(),
          },
        })
        .returning({ id: users.id, inserted: sql<boolean>`(xmax = 0)` });

      // biome-ignore lint/style/noNonNullAssertion: insert/upsert returning() yields one row
      const u = upsertResult[0]!;
      const userWasInserted = u.inserted === true;

      await tx
        .update(invitations)
        .set({ acceptedAt: new Date() })
        .where(eq(invitations.id, row.invitationId));

      // Gate emission on actual state changes — a recovery re-run leaves
      // both flags false and emits nothing, so welcome-email / billing /
      // analytics consumers don't fire twice for the same tenant.
      const eventsToEmit: Array<{
        tenantId: string;
        type: string;
        payload: Record<string, unknown>;
      }> = [];
      if (tenantWasFlipped) {
        eventsToEmit.push({
          tenantId: row.orgId,
          type: "tenant.verified",
          payload: { tenantId: row.orgId, slug: row.tenantSlug },
        });
      }
      if (userWasInserted) {
        eventsToEmit.push({
          tenantId: row.orgId,
          type: "user.jit_provisioned",
          payload: { userId: u.id, orgId: row.orgId, firstAdmin: true },
        });
      }
      if (eventsToEmit.length > 0) {
        await tx.insert(outboxEvents).values(eventsToEmit);
      }

      await tx.insert(auditLogs).values({
        orgId: row.orgId,
        userId: u.id,
        action: "tenant.verified",
        resourceType: "tenant",
        resourceId: row.orgId,
        newValues: { status: "active", firstAdmin: u.id },
        ipHash: input.ipHash,
        userAgent: input.userAgent,
      });

      return {
        ok: true as const,
        tenantId: row.orgId,
        userId: u.id,
        slug: row.tenantSlug,
        provisionalUntil: provisionalUntil.toISOString(),
      };
    });
  } catch (err) {
    // 409 from KC create user: a realm credential already exists for this
    // email. Surface the same generic 410 every other verify failure
    // produces (no enumeration oracle), but emit a structured warn so SRE
    // can grep the trail. The KC client logs its own warn at the wire
    // layer; this one carries the verify-side context (token holder, etc.).
    if (err instanceof KeycloakUserExistsError) {
      log.warn({ event: "signup.kc_user_exists" }, "verify rejected — KC user already exists");
      return { ok: false };
    }
    // `users_one_first_admin_per_org` is a partial unique on
    // (org_id WHERE first_admin=true). With the FOR UPDATE on the
    // invitation row, the original "two verify calls race" justification
    // for catching this is no longer reachable in practice; if we land
    // here it means a different code path (or manual support write)
    // already inserted an org_admin first_admin row for this tenant.
    // Stay opaque to the user (generic 410 like every other failure
    // mode), but warn loudly — a stuck-tenant-with-no-users-row state
    // needs an operator to look at it.
    if (isUniqueViolation(err, /users_one_first_admin_per_org/)) {
      log.warn(
        { event: "signup.first_admin_conflict" },
        "verify rejected — another first_admin row already exists for this tenant; needs manual triage",
      );
      return { ok: false };
    }
    throw err;
  }
}

// ─── Tenant lookup ──────────────────────────────────────────────────────────

export interface TenantLookupResult {
  hasExistingTenant: boolean;
  hint: "contact_admin" | "create_new";
}

export async function lookupTenantForEmail(email: string): Promise<TenantLookupResult> {
  const parsed = splitEmail(email);
  if (!parsed) return { hasExistingTenant: false, hint: "create_new" };

  if (isPersonalEmailDomain(parsed.domain)) {
    return { hasExistingTenant: false, hint: "create_new" };
  }

  // Owner role: tenant_domains has FORCE RLS and the request is unauthenticated.
  // Cross-tenant lookup is the entire point of the call (we're answering "is
  // this email's domain claimed by ANY tenant?"), so RLS isolation doesn't fit.
  const [claimed] = await systemDb
    .select({ orgId: tenantDomains.orgId })
    .from(tenantDomains)
    .where(and(eq(tenantDomains.domain, parsed.domain), eq(tenantDomains.state, "verified")))
    .limit(1);

  if (claimed) {
    // SEC-9: do NOT return the org's slug publicly. The hint "contact_admin"
    // tells the frontend to nudge the user without leaking the tenant identity.
    return { hasExistingTenant: true, hint: "contact_admin" };
  }
  return { hasExistingTenant: false, hint: "create_new" };
}

// ─── Cleanup: unverified provisional tenants ────────────────────────────────

/**
 * Delete `provisional` + `self_serve` tenants whose verification token
 * expired ≥ cutoff hours ago. Intended to run on a 1h cron via BullMQ.
 *
 * Atomic (DATA-7): the DELETE's WHERE re-asserts `status='provisional' AND
 * verified_at IS NULL`, so a verify call racing the cleanup cannot lose a
 * freshly-activated tenant.
 */
export async function cleanupUnverifiedTenants(
  cutoffHours = VERIFICATION_TTL_HOURS,
): Promise<number> {
  const cutoff = new Date(Date.now() - cutoffHours * 60 * 60 * 1000);

  // First, find candidates — only tenants whose latest signup-verification
  // invitation is older than cutoff count. MAX(invitations.expiresAt) handles
  // the "freshly resent" case: a resend within the last hour bumps expiresAt
  // forward, keeping the tenant alive.
  // Owner role: cleanup runs from a system cron (no user, no org context),
  // and `invitations` is FORCE RLS so the app role would see zero candidates.
  const candidates = await systemDb
    .select({ id: tenants.id })
    .from(tenants)
    .innerJoin(invitations, eq(tenants.id, invitations.orgId))
    .where(
      and(
        eq(tenants.status, "provisional"),
        eq(tenants.createdVia, "self_serve"),
        isNull(tenants.verifiedAt),
        eq(invitations.purpose, "signup_verification"),
        lt(invitations.expiresAt, cutoff),
      ),
    );

  if (candidates.length === 0) return 0;

  const ids = [...new Set(candidates.map((r) => r.id))];
  // Atomic re-assertion of invariants — even if a verify tx raced the SELECT
  // above, a verified tenant is skipped here.
  const deleted = await systemDb
    .delete(tenants)
    .where(
      and(
        inArray(tenants.id, ids),
        eq(tenants.status, "provisional"),
        isNull(tenants.verifiedAt),
        eq(tenants.createdVia, "self_serve"),
      ),
    )
    .returning({ id: tenants.id });
  return deleted.length;
}
