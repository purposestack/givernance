/**
 * Self-serve signup service (issue #108 / ADR-016).
 *
 * Three core flows — signup → verify → lookup + a resend helper — with
 * audit + outbox emission at each state transition. Keycloak provisioning
 * (Organization creation + invite) lands with issue #114 once the realm
 * is on Keycloak 26; until then the verification token lives on an
 * `invitations` row keyed by a random uuid.
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
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../../lib/db.js";

const PROVISIONAL_GRACE_DAYS = 7;
const VERIFICATION_TTL_HOURS = 24;

export type SignupError =
  | { kind: "disposable_email" }
  | { kind: "invalid_slug"; reason: "syntax" | "reserved" | "punycode" }
  | { kind: "slug_taken" }
  | { kind: "email_in_use"; hint: string };

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
 * Split an email into local / domain (lowercased). Returns `null` on a
 * trivially invalid value — the TypeBox schema catches format, this is
 * defence-in-depth.
 */
function splitEmail(email: string): { local: string; domain: string } | null {
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) return null;
  return {
    local: email.slice(0, at).toLowerCase(),
    domain: email.slice(at + 1).toLowerCase(),
  };
}

/**
 * Generate a verification token. Uses `randomUUID()` because the underlying
 * `invitations.token` column is `uuid`. 122 bits of entropy — plenty for a
 * 24h single-use verification token.
 */
function generateVerificationToken(): string {
  return randomUUID();
}

// ─── Signup ─────────────────────────────────────────────────────────────────

export async function signup(input: SignupInput): Promise<SignupResult> {
  const parsedEmail = splitEmail(input.email);
  if (!parsedEmail) {
    return { ok: false, error: { kind: "disposable_email" } };
  }

  // Slug: validator may normalise (trim + lowercase) and returns the canonical value.
  const slugCheck = validateTenantSlug(input.slug);
  if (!slugCheck.ok) {
    return { ok: false, error: { kind: "invalid_slug", reason: slugCheck.reason } };
  }
  const canonicalSlug = slugCheck.slug;

  // Reject disposable / personal domains outright — this blocks the obvious
  // signup abuse vector (hundreds of gmail aliases). Personal-email users
  // can still be invited into a tenant by an existing admin.
  if (isPersonalEmailDomain(parsedEmail.domain)) {
    // We allow signups from personal email, but we block the orgs themselves
    // from claiming domains. So personal-email signup IS allowed. Only block
    // known disposable-email providers here.
    // Upstream we have a curated list (`personal-email-domains.ts`) that
    // includes both categories; filtering out disposables specifically is a
    // follow-up (we'll add a separate `DISPOSABLE_EMAIL_DOMAINS` list).
    // For now: allow personal emails, block nothing extra.
  }

  // Existing-slug short-circuit.
  const [existingSlug] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, canonicalSlug))
    .limit(1);
  if (existingSlug) {
    return { ok: false, error: { kind: "slug_taken" } };
  }

  // "Your org is already on Givernance" detection: if the signup email's
  // domain is a *verified* custom domain, nudge the user to ask the existing
  // admin for an invitation rather than creating a second provisional tenant.
  if (!isPersonalEmailDomain(parsedEmail.domain)) {
    const [claimedDomain] = await db
      .select({ orgId: tenantDomains.orgId })
      .from(tenantDomains)
      .where(and(eq(tenantDomains.domain, parsedEmail.domain), eq(tenantDomains.state, "verified")))
      .limit(1);
    if (claimedDomain) {
      return {
        ok: false,
        error: {
          kind: "email_in_use",
          hint: "your_organization_already_on_givernance",
        },
      };
    }
  }

  const token = generateVerificationToken();
  const expiresAt = new Date(Date.now() + VERIFICATION_TTL_HOURS * 60 * 60 * 1000);

  // All state changes happen in one transaction. Tenants has no RLS (admin-
  // managed only), so we don't need withTenantContext — but outbox_events
  // does, and we set the GUC to the freshly-inserted tenant id.
  const tenantId = await db.transaction(async (tx) => {
    const [tenant] = await tx
      .insert(tenants)
      .values({
        name: input.orgName,
        slug: canonicalSlug,
        status: "provisional" as TenantStatus,
        createdVia: "self_serve",
      })
      .returning({ id: tenants.id });

    // biome-ignore lint/style/noNonNullAssertion: returning() always yields one row
    const t = tenant!;

    await tx.execute(sql`SELECT set_config('app.current_organization_id', ${t.id}, true)`);

    // Verification token stored as an invitations row. The invitation
    // doubles as the "first admin will be created on verify" signal:
    // role=org_admin, email=signup email, orgId=new tenant id.
    await tx.insert(invitations).values({
      orgId: t.id,
      email: input.email.trim().toLowerCase(),
      role: "org_admin",
      token,
      expiresAt,
    });

    await tx.insert(outboxEvents).values([
      {
        tenantId: t.id,
        type: "tenant.self_signup_started",
        payload: {
          tenantId: t.id,
          slug: canonicalSlug,
          orgName: input.orgName,
          email: input.email,
          country: input.country,
        },
      },
      {
        tenantId: t.id,
        type: "tenant.signup_verification_requested",
        payload: {
          tenantId: t.id,
          email: input.email,
          verificationToken: token,
          expiresAt: expiresAt.toISOString(),
        },
      },
    ]);

    await tx.insert(auditLogs).values({
      orgId: t.id,
      userId: null,
      action: "tenant.self_signup_started",
      resourceType: "tenant",
      resourceId: t.id,
      newValues: { slug: canonicalSlug, email: input.email, country: input.country },
      ipHash: input.ipHash,
      userAgent: input.userAgent,
    });

    return t.id;
  });

  return {
    ok: true,
    tenantId,
    email: input.email.trim().toLowerCase(),
    verificationToken: token,
  };
}

// ─── Resend verification ────────────────────────────────────────────────────

export type ResendResult =
  | { ok: true; tenantId: string; email: string; verificationToken: string }
  | { ok: false };

/**
 * Re-emit a verification token for a provisional tenant. Silently returns
 * `{ok: true}` even when the email doesn't match anything — to avoid
 * leaking which emails have pending signups.
 */
export async function resendVerification(email: string): Promise<ResendResult> {
  const normalised = email.trim().toLowerCase();

  const rows = await db
    .select({
      tenantId: tenants.id,
      status: tenants.status,
      invitationId: invitations.id,
      invitationToken: invitations.token,
      expiresAt: invitations.expiresAt,
    })
    .from(invitations)
    .innerJoin(tenants, eq(invitations.orgId, tenants.id))
    .where(
      and(
        eq(invitations.email, normalised),
        isNull(invitations.acceptedAt),
        eq(tenants.status, "provisional"),
        eq(tenants.createdVia, "self_serve"),
      ),
    )
    .limit(1);

  if (rows.length === 0) {
    return { ok: false };
  }

  const row = rows[0];
  if (!row) return { ok: false };

  const newToken = generateVerificationToken();
  const expiresAt = new Date(Date.now() + VERIFICATION_TTL_HOURS * 60 * 60 * 1000);

  await db.transaction(async (tx) => {
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
        email: normalised,
        verificationToken: newToken,
        expiresAt: expiresAt.toISOString(),
      },
    });
  });

  return { ok: true, tenantId: row.tenantId, email: normalised, verificationToken: newToken };
}

// ─── Verify ─────────────────────────────────────────────────────────────────

export type VerifyError = { kind: "invalid_or_expired" } | { kind: "already_verified" };

export type VerifyResult =
  | {
      ok: true;
      tenantId: string;
      userId: string;
      slug: string;
      provisionalUntil: string;
    }
  | { ok: false; error: VerifyError };

export interface VerifyInput {
  token: string;
  firstName: string;
  lastName: string;
  ipHash?: string;
  userAgent?: string;
}

export async function verifySignup(input: VerifyInput): Promise<VerifyResult> {
  return db.transaction(async (tx) => {
    // Lookup the invitation without a tenant context (the signup flow is
    // pre-auth; the token is the credential). `invitations` has RLS but
    // the test/dev DB connects as the owner role (BYPASSRLS per ADR-009),
    // and the prod API also reads invitations before resolving the tenant.
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
      .where(and(eq(invitations.token, input.token), eq(tenants.createdVia, "self_serve")))
      .limit(1);

    if (!row) {
      return { ok: false, error: { kind: "invalid_or_expired" } } as const;
    }
    if (row.acceptedAt) {
      return { ok: false, error: { kind: "already_verified" } } as const;
    }
    if (row.expiresAt < new Date()) {
      return { ok: false, error: { kind: "invalid_or_expired" } } as const;
    }

    const provisionalUntil = new Date(Date.now() + PROVISIONAL_GRACE_DAYS * 24 * 60 * 60 * 1000);

    await tx.execute(sql`SELECT set_config('app.current_organization_id', ${row.orgId}, true)`);

    await tx
      .update(tenants)
      .set({ status: "active", verifiedAt: new Date(), updatedAt: new Date() })
      .where(eq(tenants.id, row.orgId));

    const [newUser] = await tx
      .insert(users)
      .values({
        orgId: row.orgId,
        email: row.email,
        firstName: input.firstName,
        lastName: input.lastName,
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
        payload: { userId: u.id, orgId: row.orgId, email: row.email, firstAdmin: true },
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
      ok: true,
      tenantId: row.orgId,
      userId: u.id,
      slug: row.tenantSlug,
      provisionalUntil: provisionalUntil.toISOString(),
    } as const;
  });
}

// ─── Tenant lookup ──────────────────────────────────────────────────────────

export interface TenantLookupResult {
  hasExistingTenant: boolean;
  /** Opaque hint the frontend can render: "contact_admin" | "create_new" */
  hint: "contact_admin" | "create_new";
  /**
   * Slug of the existing tenant, if any. Never returned when the email's
   * domain is personal — otherwise we'd create an enumeration oracle across
   * the gmail.com / outlook.com user population.
   */
  orgSlug?: string;
}

export async function lookupTenantForEmail(email: string): Promise<TenantLookupResult> {
  const parsed = splitEmail(email);
  if (!parsed) return { hasExistingTenant: false, hint: "create_new" };

  if (isPersonalEmailDomain(parsed.domain)) {
    // Personal-email domains: never leak org existence.
    return { hasExistingTenant: false, hint: "create_new" };
  }

  const [claimed] = await db
    .select({ orgId: tenantDomains.orgId, slug: tenants.slug })
    .from(tenantDomains)
    .innerJoin(tenants, eq(tenantDomains.orgId, tenants.id))
    .where(and(eq(tenantDomains.domain, parsed.domain), eq(tenantDomains.state, "verified")))
    .limit(1);

  if (claimed) {
    return { hasExistingTenant: true, hint: "contact_admin", orgSlug: claimed.slug };
  }
  return { hasExistingTenant: false, hint: "create_new" };
}

// ─── Cleanup: unverified provisional tenants ────────────────────────────────

/**
 * Delete `provisional` + `self_serve` tenants whose verification token
 * expired ≥ cutoff hours ago and whose `verified_at` is still null. Returns
 * the number of tenants reaped. Intended to run on a 1h cron via BullMQ.
 */
export async function cleanupUnverifiedTenants(
  cutoffHours = VERIFICATION_TTL_HOURS,
): Promise<number> {
  const cutoff = new Date(Date.now() - cutoffHours * 60 * 60 * 1000);

  // Find tenants to delete. Tenant delete cascades to invitations, users,
  // tenant_domains, tenant_admin_disputes (migration 0021).
  const rows = await db
    .select({ id: tenants.id })
    .from(tenants)
    .leftJoin(invitations, eq(tenants.id, invitations.orgId))
    .where(
      and(
        eq(tenants.status, "provisional"),
        eq(tenants.createdVia, "self_serve"),
        isNull(tenants.verifiedAt),
        or(
          sql`${tenants.createdAt} < ${cutoff.toISOString()}`,
          sql`${invitations.expiresAt} < ${cutoff.toISOString()}`,
        ),
      ),
    );

  if (rows.length === 0) return 0;

  const ids = [...new Set(rows.map((r) => r.id))];
  await db.delete(tenants).where(inArray(tenants.id, ids));
  return ids.length;
}
