/**
 * Self-serve signup service (issue #108 / ADR-016).
 *
 * Three core flows — signup → verify → lookup + a resend helper — with
 * audit + outbox emission at each state transition. Keycloak provisioning
 * (Organization creation + invite) lands with issue #114 once the realm
 * is on Keycloak 26; until then the verification token lives on an
 * `invitations` row with `purpose='signup_verification'` (migration 0022).
 *
 * Review pass (PR #117):
 *  - SEC-1 / DATA-3: invitations carry `purpose='signup_verification'`;
 *    the team-invite endpoint filters to `purpose='team_invite'`.
 *  - SEC-5 / ENG-4: slug / domain conflicts return 409; error messages
 *    collapsed to a single generic "Signup could not be completed".
 *  - SEC-6: verify endpoint collapses "expired" / "already verified" /
 *    "unknown token" into one 410 generic to kill the enumeration oracle.
 *  - SEC-7: outbox `payload` + audit `newValues` no longer carry the raw
 *    verification token; the email worker looks it up by invitation id.
 *  - DATA-1: 23505 unique violations on slug/domain are mapped to 409
 *    results instead of a 500.
 *  - DATA-2: `email_in_use` now also triggers when a `users.email` row
 *    exists in any tenant — covers the existing-user case from ADR-016.
 *  - DATA-7: `cleanupUnverifiedTenants` re-asserts invariants inside the
 *    DELETE's WHERE (atomic with any concurrent verify).
 *  - ENG-2: dropped the dead `disposable_email` branch.
 *  - ENG-9: `verifySignup` reads the invitation FOR UPDATE + catches the
 *    `users_one_first_admin_per_org` unique-violation → `already_verified`.
 */

import { randomUUID } from "node:crypto";
import { isPersonalEmailDomain } from "@givernance/shared/constants";
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
import { db, systemDb } from "../../lib/db.js";

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
 * Re-emit a verification token for a provisional tenant. Silently returns
 * `{ok: false}` if nothing matches — the route always responds 204 so the
 * endpoint cannot be used as an email-enumeration oracle.
 */
export async function resendVerification(email: string): Promise<ResendResult> {
  const normalised = email.trim().toLowerCase();

  // Owner role: same justification as verifySignup — no org context yet, and
  // the app role would have RLS filter the invitation join to zero rows.
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
    .where(
      and(
        eq(invitations.email, normalised),
        eq(invitations.purpose, "signup_verification"),
        isNull(invitations.acceptedAt),
        eq(tenants.status, "provisional"),
        eq(tenants.createdVia, "self_serve"),
      ),
    )
    .orderBy(sql`${invitations.createdAt} DESC`)
    .limit(1);

  if (rows.length === 0) {
    return { ok: false };
  }

  const row = rows[0];
  if (!row) return { ok: false };

  const newToken = generateVerificationToken();
  const expiresAt = new Date(Date.now() + VERIFICATION_TTL_HOURS * 60 * 60 * 1000);

  await systemDb.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_organization_id', ${row.tenantId}, true)`);

    await tx
      .update(invitations)
      .set({ token: newToken, expiresAt })
      .where(eq(invitations.id, row.invitationId));

    await tx.insert(outboxEvents).values({
      tenantId: row.tenantId,
      type: "tenant.signup_verification_resent",
      payload: {
        tenantId: row.tenantId,
        invitationId: row.invitationId,
        expiresAt: expiresAt.toISOString(),
      },
    });
  });

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
  ipHash?: string;
  userAgent?: string;
}

export async function verifySignup(input: VerifyInput): Promise<VerifyResult> {
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();

  try {
    // Owner role: the verify request is unauthenticated, so we have no org
    // context to set before the SELECT — the app role would have RLS hide
    // the invitation row and we'd return ok:false for every valid token.
    // The unguessable token IS the security boundary here.
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
          tenantSlug: tenants.slug,
          tenantStatus: tenants.status,
          createdVia: tenants.createdVia,
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

      await tx
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
        );

      const [newUser] = await tx
        .insert(users)
        .values({
          orgId: row.orgId,
          email: row.email,
          firstName,
          lastName,
          role: "org_admin",
          firstAdmin: true,
          provisionalUntil,
        })
        .returning({ id: users.id });

      // biome-ignore lint/style/noNonNullAssertion: returning() yields one row for single insert
      const u = newUser!;

      await tx
        .update(invitations)
        .set({ acceptedAt: new Date() })
        .where(eq(invitations.id, row.invitationId));

      await tx.insert(outboxEvents).values([
        {
          tenantId: row.orgId,
          type: "tenant.verified",
          payload: { tenantId: row.orgId, slug: row.tenantSlug },
        },
        {
          tenantId: row.orgId,
          type: "user.jit_provisioned",
          payload: { userId: u.id, orgId: row.orgId, firstAdmin: true },
        },
      ]);

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
    // If two verify calls race past the row-lock (unlikely but defensive),
    // the unique partial index `users_one_first_admin_per_org` fires. Treat
    // that the same way as a stale token — one generic failure response.
    if (isUniqueViolation(err, /users_one_first_admin_per_org/)) {
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
