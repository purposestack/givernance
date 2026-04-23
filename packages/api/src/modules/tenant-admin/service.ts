/**
 * Enterprise-track tenant lifecycle + domain claim + IdP provisioning service
 * (issue #110 / ADR-016 / doc 22 §3.2, §5).
 *
 * All side-effects are wrapped in DB transactions with outbox + audit emission
 * so the Keycloak Admin API call and the DB state land atomically from the
 * caller's perspective. Keycloak failures throw `KeycloakAdminError` which the
 * route handler maps to 502/503.
 */

import { randomBytes } from "node:crypto";
import {
  auditLogs,
  invitations,
  outboxEvents,
  type TenantCreatedVia,
  type TenantStatus,
  tenantDomains,
  tenants,
  users,
} from "@givernance/shared/schema";
import { validateTenantSlug } from "@givernance/shared/validators";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, withTenantContext } from "../../lib/db.js";
import {
  createSystemTxtResolver,
  generateDnsTxtValue,
  type TxtResolver,
  verifyTxtRecord,
} from "../../lib/dns.js";
import type { KeycloakAdminClient } from "../../lib/keycloak-admin.js";
import { keycloakAdmin } from "../../lib/keycloak-admin.js";
import { assertSafeUpstreamUrl } from "../../lib/url-safety.js";

// ─── Shared helpers ─────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

export interface AuditContext {
  actorUserId: string | null;
  ipHash?: string;
  userAgent?: string;
}

// ─── Enterprise tenant creation (super-admin) ──────────────────────────────

export type CreateEnterpriseTenantResult =
  | {
      ok: true;
      tenantId: string;
      slug: string;
      keycloakOrgId: string;
    }
  | { ok: false; error: "invalid_slug" | "slug_taken" };

export interface CreateEnterpriseTenantInput {
  name: string;
  slug: string;
  plan?: "starter" | "pro" | "enterprise";
  audit: AuditContext;
}

/**
 * Create an enterprise-track tenant.
 *  - Row in `tenants` with status='provisional', created_via='enterprise'.
 *  - Corresponding Keycloak Organization (alias = slug).
 *  - Audit + outbox for the transition.
 *
 * On Keycloak failure after the DB commit, the DB row is left as 'provisional'
 * without a `keycloak_org_id`; the super-admin can retry via `POST :id/retry`
 * (not modelled here — they can also `DELETE` + recreate in MVP).
 */
export async function createEnterpriseTenant(
  input: CreateEnterpriseTenantInput,
  deps: { kc?: KeycloakAdminClient } = {},
): Promise<CreateEnterpriseTenantResult> {
  const slugCheck = validateTenantSlug(input.slug);
  if (!slugCheck.ok) return { ok: false, error: "invalid_slug" };
  const canonicalSlug = slugCheck.slug;

  const [existing] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, canonicalSlug))
    .limit(1);
  if (existing) return { ok: false, error: "slug_taken" };

  const kc = deps.kc ?? keycloakAdmin();

  // Step 1: create Keycloak Organization FIRST so we can store the id atomically.
  // If KC fails, no DB row is left behind.
  const org = await kc.createOrganization({
    name: input.name,
    alias: canonicalSlug,
    attributes: { org_slug: [canonicalSlug] },
  });

  try {
    const tenantId = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(tenants)
        .values({
          name: input.name,
          slug: canonicalSlug,
          plan: input.plan ?? "starter",
          status: "provisional" as TenantStatus,
          createdVia: "enterprise" as TenantCreatedVia,
          keycloakOrgId: org.id,
        })
        .returning({ id: tenants.id });
      // biome-ignore lint/style/noNonNullAssertion: returning() yields one row
      const t = row!;

      await tx.execute(sql`SELECT set_config('app.current_organization_id', ${t.id}, true)`);

      await tx.insert(outboxEvents).values({
        tenantId: t.id,
        type: "tenant.enterprise_created",
        payload: { tenantId: t.id, slug: canonicalSlug, keycloakOrgId: org.id },
      });

      await tx.insert(auditLogs).values({
        orgId: t.id,
        userId: input.audit.actorUserId,
        action: "tenant.enterprise_created",
        resourceType: "tenant",
        resourceId: t.id,
        newValues: { slug: canonicalSlug, keycloakOrgId: org.id, status: "provisional" },
        ipHash: input.audit.ipHash,
        userAgent: input.audit.userAgent,
      });

      return t.id;
    });

    return { ok: true, tenantId, slug: canonicalSlug, keycloakOrgId: org.id };
  } catch (err) {
    // Best-effort compensation: remove the orphan KC org so a retry succeeds.
    try {
      await kc.deleteOrganization(org.id);
    } catch {
      // Swallow — we'll leak an org in KC but the DB stays consistent.
    }
    throw err;
  }
}

// ─── Domain claim / verify / revoke ────────────────────────────────────────

export type DomainClaimResult =
  | { ok: true; domain: string; dnsTxtValue: string; state: "pending_dns" }
  | {
      ok: false;
      error: "invalid_domain" | "personal_email" | "already_claimed" | "tenant_not_found";
    };

export interface DomainClaimInput {
  orgId: string;
  domain: string;
  audit: AuditContext;
}

/** Claim a domain on a tenant — generates DNS TXT token, INSERTs pending_dns. */
export async function claimDomain(input: DomainClaimInput): Promise<DomainClaimResult> {
  if (!isUuid(input.orgId)) return { ok: false, error: "tenant_not_found" };

  // Import lazily to avoid creating a web/api dependency cycle in tests.
  const { validateTenantDomain } = await import("@givernance/shared/constants");
  const parsed = validateTenantDomain(input.domain);
  if (!parsed.ok) {
    return {
      ok: false,
      error: parsed.reason === "personal_email" ? "personal_email" : "invalid_domain",
    };
  }

  // Tenant must exist + be alive (not archived).
  const [tenant] = await db
    .select({ id: tenants.id, status: tenants.status })
    .from(tenants)
    .where(eq(tenants.id, input.orgId))
    .limit(1);
  if (!tenant || tenant.status === "archived") {
    return { ok: false, error: "tenant_not_found" };
  }

  // Pre-check global domain uniqueness among active rows (the partial unique
  // index is the real enforcer; this preempt returns a friendlier error).
  const [conflict] = await db
    .select({ id: tenantDomains.id })
    .from(tenantDomains)
    .where(and(eq(tenantDomains.domain, parsed.domain), sql`${tenantDomains.state} <> 'revoked'`))
    .limit(1);
  if (conflict) return { ok: false, error: "already_claimed" };

  const dnsTxtValue = generateDnsTxtValue(randomBytes(24));

  try {
    const row = await withTenantContext(input.orgId, async (tx) => {
      const [inserted] = await tx
        .insert(tenantDomains)
        .values({
          orgId: input.orgId,
          domain: parsed.domain,
          dnsTxtValue,
          state: "pending_dns",
        })
        .returning({ id: tenantDomains.id });

      await tx.insert(outboxEvents).values({
        tenantId: input.orgId,
        type: "tenant.domain_claimed",
        payload: { tenantId: input.orgId, domain: parsed.domain },
      });

      await tx.insert(auditLogs).values({
        orgId: input.orgId,
        userId: input.audit.actorUserId,
        action: "tenant.domain_claimed",
        resourceType: "tenant_domain",
        resourceId: inserted?.id ?? null,
        newValues: { domain: parsed.domain, state: "pending_dns" },
        ipHash: input.audit.ipHash,
        userAgent: input.audit.userAgent,
      });

      return inserted;
    });
    if (!row) return { ok: false, error: "already_claimed" };

    return { ok: true, domain: parsed.domain, dnsTxtValue, state: "pending_dns" };
  } catch (err) {
    if (
      isUniqueViolation(err, /tenant_domains_active_domain_uniq|tenant_domains_active_txt_uniq/)
    ) {
      return { ok: false, error: "already_claimed" };
    }
    throw err;
  }
}

export type DomainVerifyResult =
  | { ok: true; domain: string; state: "verified" }
  | {
      ok: false;
      error: "not_found" | "dns_mismatch" | "dns_timeout" | "tenant_not_found" | "already_verified";
    };

export interface DomainVerifyInput {
  orgId: string;
  domain: string;
  audit: AuditContext;
}

/**
 * Verify a pending domain by resolving its DNS TXT. On success, transition to
 * `verified` and add the domain to the Keycloak Organization (with the
 * verified flag set — ADR-016 safeguard against premature binding).
 */
export async function verifyDomain(
  input: DomainVerifyInput,
  deps: { resolver?: TxtResolver; kc?: KeycloakAdminClient } = {},
): Promise<DomainVerifyResult> {
  if (!isUuid(input.orgId)) return { ok: false, error: "tenant_not_found" };
  const domain = input.domain.trim().toLowerCase();

  const [tenant] = await db
    .select({ id: tenants.id, keycloakOrgId: tenants.keycloakOrgId })
    .from(tenants)
    .where(eq(tenants.id, input.orgId))
    .limit(1);
  if (!tenant) return { ok: false, error: "tenant_not_found" };

  const claimLookup = await loadVerifiableClaim(input.orgId, domain);
  if (!claimLookup.ok) return { ok: false, error: claimLookup.error };
  const claim = claimLookup.claim;

  const resolver = deps.resolver ?? createSystemTxtResolver();
  const txt = await verifyTxtRecord(resolver, {
    domain,
    expectedValue: claim.dnsTxtValue,
  });
  if (!txt.ok) {
    return { ok: false, error: txt.reason === "timeout" ? "dns_timeout" : "dns_mismatch" };
  }

  await bindDomainToKeycloak(tenant.keycloakOrgId, domain, deps.kc);
  await commitDomainVerification(input, claim.id, domain);

  return { ok: true, domain, state: "verified" };
}

async function loadVerifiableClaim(
  orgId: string,
  domain: string,
): Promise<
  | {
      ok: true;
      claim: { id: string; orgId: string; state: string; dnsTxtValue: string };
    }
  | { ok: false; error: "not_found" | "already_verified" }
> {
  const [claim] = await db
    .select({
      id: tenantDomains.id,
      orgId: tenantDomains.orgId,
      state: tenantDomains.state,
      dnsTxtValue: tenantDomains.dnsTxtValue,
    })
    .from(tenantDomains)
    .where(and(eq(tenantDomains.orgId, orgId), eq(tenantDomains.domain, domain)))
    .limit(1);
  if (!claim) return { ok: false, error: "not_found" };
  if (claim.state === "verified") return { ok: false, error: "already_verified" };
  if (claim.state === "revoked") return { ok: false, error: "not_found" };
  return { ok: true, claim };
}

// Bind to Keycloak Organization IF the tenant has one (enterprise track).
// Self-serve tenants without a KC org are still allowed to verify for the
// Home IdP Discovery feature once #114 lands.
//
// DATA-3: tolerate KC 409 ("already attached") so a retry after a DB-commit
// failure on the prior attempt doesn't leave the claim stuck in `pending_dns`.
async function bindDomainToKeycloak(
  keycloakOrgId: string | null,
  domain: string,
  kcOverride: KeycloakAdminClient | undefined,
): Promise<void> {
  if (!keycloakOrgId) return;
  const kc = kcOverride ?? keycloakAdmin();
  try {
    await kc.addOrgDomain(keycloakOrgId, domain, { verified: true });
  } catch (err) {
    if (!isKeycloakConflict(err)) throw err;
  }
}

async function commitDomainVerification(
  input: DomainVerifyInput,
  claimId: string,
  domain: string,
): Promise<void> {
  await withTenantContext(input.orgId, async (tx) => {
    await tx
      .update(tenantDomains)
      .set({ state: "verified", verifiedAt: new Date() })
      .where(eq(tenantDomains.id, claimId));

    // Denormalised pointer on tenants; first verified domain wins.
    await tx
      .update(tenants)
      .set({ primaryDomain: domain, updatedAt: new Date() })
      .where(and(eq(tenants.id, input.orgId), sql`${tenants.primaryDomain} IS NULL`));

    await tx.insert(outboxEvents).values({
      tenantId: input.orgId,
      type: "tenant.domain_verified",
      payload: { tenantId: input.orgId, domain },
    });

    await tx.insert(auditLogs).values({
      orgId: input.orgId,
      userId: input.audit.actorUserId,
      action: "tenant.domain_verified",
      resourceType: "tenant_domain",
      resourceId: claimId,
      oldValues: { state: "pending_dns" },
      newValues: { state: "verified" },
      ipHash: input.audit.ipHash,
      userAgent: input.audit.userAgent,
    });
  });
}

export type DomainRevokeResult = { ok: true; domain: string } | { ok: false; error: "not_found" };

export async function revokeDomain(input: DomainVerifyInput): Promise<DomainRevokeResult> {
  if (!isUuid(input.orgId)) return { ok: false, error: "not_found" };
  const domain = input.domain.trim().toLowerCase();

  const result = await withTenantContext(input.orgId, async (tx) => {
    // SEC-10: capture the pre-revoke state explicitly — `.returning()` yields
    // post-update values, so we'd otherwise audit `oldValues: { state: 'revoked' }`.
    const [prior] = await tx
      .select({ id: tenantDomains.id, state: tenantDomains.state })
      .from(tenantDomains)
      .where(
        and(
          eq(tenantDomains.orgId, input.orgId),
          eq(tenantDomains.domain, domain),
          sql`${tenantDomains.state} <> 'revoked'`,
        ),
      )
      .for("update")
      .limit(1);
    if (!prior) return null;

    await tx.update(tenantDomains).set({ state: "revoked" }).where(eq(tenantDomains.id, prior.id));

    // Clear the tenants.primary_domain pointer if it matched this claim.
    await tx
      .update(tenants)
      .set({ primaryDomain: null, updatedAt: new Date() })
      .where(and(eq(tenants.id, input.orgId), eq(tenants.primaryDomain, domain)));

    await tx.insert(outboxEvents).values({
      tenantId: input.orgId,
      type: "tenant.domain_revoked",
      payload: { tenantId: input.orgId, domain },
    });

    await tx.insert(auditLogs).values({
      orgId: input.orgId,
      userId: input.audit.actorUserId,
      action: "tenant.domain_revoked",
      resourceType: "tenant_domain",
      resourceId: prior.id,
      oldValues: { state: prior.state },
      newValues: { state: "revoked" },
      ipHash: input.audit.ipHash,
      userAgent: input.audit.userAgent,
    });

    return prior;
  });

  if (!result) return { ok: false, error: "not_found" };
  return { ok: true, domain };
}

// ─── IdP provisioning (super-admin) ─────────────────────────────────────────

export type IdpProvisionResult =
  | { ok: true; alias: string }
  | {
      ok: false;
      error: "tenant_not_found" | "tenant_has_no_org" | "invalid_config" | "alias_taken";
    };

export interface OidcIdpConfig {
  type: "oidc";
  /**
   * Either a discovery URL that the implementation will fetch, or explicit
   * authorization/token URLs + issuer. Caller is responsible for passing one
   * of the two shapes.
   */
  discoveryUrl?: string;
  issuer?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  userInfoUrl?: string;
  clientId: string;
  clientSecret: string;
  /** Optional role-mapping hints — key/value passed through to KC config. */
  roleMappings?: Record<string, string>;
}

export interface SamlIdpConfig {
  type: "saml";
  entityId: string;
  singleSignOnServiceUrl: string;
  x509Certificate: string;
  nameIdPolicyFormat?: string;
}

export type IdpConfig = OidcIdpConfig | SamlIdpConfig;

export interface ProvisionIdpInput {
  orgId: string;
  config: IdpConfig;
  audit: AuditContext;
}

/**
 * Translate our validated IdP config into Keycloak's shape. Caller-supplied
 * URLs are filtered through `assertSafeUpstreamUrl` first (SEC-1, see
 * `lib/url-safety.ts`) so we never ask Keycloak to deref a loopback / private
 * / metadata host from inside our trust boundary.
 */
function buildKcIdpConfig(
  config: IdpConfig,
): { ok: true; kc: Record<string, string> } | { ok: false } {
  const requireHttps = process.env.NODE_ENV === "production";
  const safe = (u: string | undefined): string | undefined | null => {
    if (!u) return undefined;
    const r = assertSafeUpstreamUrl(u, { requireHttps });
    return r.ok ? r.url : null;
  };

  if (config.type === "oidc") {
    if (!config.clientId || !config.clientSecret) return { ok: false };
    const kc: Record<string, string> = {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    };
    const pairs: Array<[string, string | undefined]> = [
      ["discoveryEndpoint", config.discoveryUrl],
      ["issuer", config.issuer],
      ["authorizationUrl", config.authorizationUrl],
      ["tokenUrl", config.tokenUrl],
      ["userInfoUrl", config.userInfoUrl],
    ];
    for (const [kcKey, raw] of pairs) {
      const v = safe(raw);
      if (v === null) return { ok: false };
      if (v !== undefined) kc[kcKey] = v;
    }
    return { ok: true, kc };
  }

  // SAML
  const ssoSafe = safe(config.singleSignOnServiceUrl);
  if (ssoSafe === null || !ssoSafe) return { ok: false };
  return {
    ok: true,
    kc: {
      entityId: config.entityId,
      singleSignOnServiceUrl: ssoSafe,
      signingCertificate: config.x509Certificate,
      nameIDPolicyFormat:
        config.nameIdPolicyFormat ?? "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    },
  };
}

export async function provisionIdp(
  input: ProvisionIdpInput,
  deps: { kc?: KeycloakAdminClient } = {},
): Promise<IdpProvisionResult> {
  if (!isUuid(input.orgId)) return { ok: false, error: "tenant_not_found" };
  const [tenant] = await db
    .select({ id: tenants.id, slug: tenants.slug, keycloakOrgId: tenants.keycloakOrgId })
    .from(tenants)
    .where(eq(tenants.id, input.orgId))
    .limit(1);
  if (!tenant) return { ok: false, error: "tenant_not_found" };
  if (!tenant.keycloakOrgId) return { ok: false, error: "tenant_has_no_org" };

  const alias = `tenant-${tenant.slug}`;
  const built = buildKcIdpConfig(input.config);
  if (!built.ok) return { ok: false, error: "invalid_config" };

  const kc = deps.kc ?? keycloakAdmin();

  try {
    await kc.createIdentityProvider({
      alias,
      providerId: input.config.type,
      enabled: true,
      config: built.kc,
    });
    await kc.bindIdpToOrganization(tenant.keycloakOrgId, { alias });
  } catch (err) {
    // 409 from KC means an IdP with that alias already exists — treat as taken.
    if (isKeycloakConflict(err)) return { ok: false, error: "alias_taken" };
    throw err;
  }

  await withTenantContext(input.orgId, async (tx) => {
    await tx.insert(outboxEvents).values({
      tenantId: input.orgId,
      type: "tenant.idp_provisioned",
      payload: { tenantId: input.orgId, alias, providerType: input.config.type },
    });
    await tx.insert(auditLogs).values({
      orgId: input.orgId,
      userId: input.audit.actorUserId,
      action: "tenant.idp_provisioned",
      resourceType: "tenant_idp",
      resourceId: alias,
      newValues: { alias, providerType: input.config.type },
      ipHash: input.audit.ipHash,
      userAgent: input.audit.userAgent,
    });
    // Flip provisional → active once an IdP is bound.
    await tx
      .update(tenants)
      .set({ status: "active", updatedAt: new Date() })
      .where(and(eq(tenants.id, input.orgId), eq(tenants.status, "provisional")));
  });

  return { ok: true, alias };
}

export type IdpDeleteResult = { ok: true } | { ok: false; error: "tenant_not_found" | "not_bound" };

export async function deleteIdp(
  input: { orgId: string; audit: AuditContext },
  deps: { kc?: KeycloakAdminClient } = {},
): Promise<IdpDeleteResult> {
  if (!isUuid(input.orgId)) return { ok: false, error: "tenant_not_found" };
  const [tenant] = await db
    .select({ id: tenants.id, slug: tenants.slug, keycloakOrgId: tenants.keycloakOrgId })
    .from(tenants)
    .where(eq(tenants.id, input.orgId))
    .limit(1);
  if (!tenant) return { ok: false, error: "tenant_not_found" };
  if (!tenant.keycloakOrgId) return { ok: false, error: "not_bound" };

  const alias = `tenant-${tenant.slug}`;
  const kc = deps.kc ?? keycloakAdmin();
  try {
    await kc.deleteIdentityProvider(alias);
  } catch (err) {
    // 404 = already gone — idempotent success path.
    if (!isKeycloakNotFound(err)) throw err;
  }

  await withTenantContext(input.orgId, async (tx) => {
    await tx.insert(outboxEvents).values({
      tenantId: input.orgId,
      type: "tenant.idp_removed",
      payload: { tenantId: input.orgId, alias },
    });
    await tx.insert(auditLogs).values({
      orgId: input.orgId,
      userId: input.audit.actorUserId,
      action: "tenant.idp_removed",
      resourceType: "tenant_idp",
      resourceId: alias,
      oldValues: { alias },
      ipHash: input.audit.ipHash,
      userAgent: input.audit.userAgent,
    });
  });

  return { ok: true };
}

// ─── List tenants for the admin UI ─────────────────────────────────────────

export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  plan: string;
  status: string;
  createdVia: string;
  verifiedAt: string | null;
  primaryDomain: string | null;
  keycloakOrgId: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function listTenantsForAdmin(filters: {
  status?: string;
  createdVia?: string;
  q?: string;
}): Promise<TenantSummary[]> {
  const conditions = [];
  if (filters.status) conditions.push(eq(tenants.status, filters.status as TenantStatus));
  if (filters.createdVia) {
    conditions.push(eq(tenants.createdVia, filters.createdVia as TenantCreatedVia));
  }
  if (filters.q) {
    const like = `%${filters.q.trim().toLowerCase()}%`;
    conditions.push(
      sql`lower(${tenants.name}) LIKE ${like} OR lower(${tenants.slug}) LIKE ${like}`,
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const rows = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      slug: tenants.slug,
      plan: tenants.plan,
      status: tenants.status,
      createdVia: tenants.createdVia,
      verifiedAt: tenants.verifiedAt,
      primaryDomain: tenants.primaryDomain,
      keycloakOrgId: tenants.keycloakOrgId,
      createdAt: tenants.createdAt,
      updatedAt: tenants.updatedAt,
    })
    .from(tenants)
    .where(where ?? sql`true`)
    .orderBy(sql`${tenants.createdAt} DESC`)
    .limit(200);

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    plan: r.plan,
    status: r.status,
    createdVia: r.createdVia,
    verifiedAt: r.verifiedAt?.toISOString() ?? null,
    primaryDomain: r.primaryDomain,
    keycloakOrgId: r.keycloakOrgId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function getTenantDetail(orgId: string): Promise<{
  tenant: TenantSummary;
  domains: Array<{
    id: string;
    domain: string;
    state: string;
    dnsTxtValue: string;
    verifiedAt: string | null;
    createdAt: string;
  }>;
  users: Array<{
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    role: string;
    firstAdmin: boolean;
    provisionalUntil: string | null;
    lastVisitedAt: string | null;
  }>;
} | null> {
  if (!isUuid(orgId)) return null;

  const [tenant] = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      slug: tenants.slug,
      plan: tenants.plan,
      status: tenants.status,
      createdVia: tenants.createdVia,
      verifiedAt: tenants.verifiedAt,
      primaryDomain: tenants.primaryDomain,
      keycloakOrgId: tenants.keycloakOrgId,
      createdAt: tenants.createdAt,
      updatedAt: tenants.updatedAt,
    })
    .from(tenants)
    .where(eq(tenants.id, orgId))
    .limit(1);
  if (!tenant) return null;

  const [domainRows, userRows] = await Promise.all([
    db
      .select({
        id: tenantDomains.id,
        domain: tenantDomains.domain,
        state: tenantDomains.state,
        dnsTxtValue: tenantDomains.dnsTxtValue,
        verifiedAt: tenantDomains.verifiedAt,
        createdAt: tenantDomains.createdAt,
      })
      .from(tenantDomains)
      .where(eq(tenantDomains.orgId, orgId)),
    db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        role: users.role,
        firstAdmin: users.firstAdmin,
        provisionalUntil: users.provisionalUntil,
        lastVisitedAt: users.lastVisitedAt,
      })
      .from(users)
      .where(eq(users.orgId, orgId)),
  ]);

  return {
    tenant: {
      ...tenant,
      verifiedAt: tenant.verifiedAt?.toISOString() ?? null,
      createdAt: tenant.createdAt.toISOString(),
      updatedAt: tenant.updatedAt.toISOString(),
    },
    domains: domainRows.map((d) => ({
      id: d.id,
      domain: d.domain,
      state: d.state,
      dnsTxtValue: d.dnsTxtValue,
      verifiedAt: d.verifiedAt?.toISOString() ?? null,
      createdAt: d.createdAt.toISOString(),
    })),
    users: userRows.map((u) => ({
      id: u.id,
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      role: u.role,
      firstAdmin: u.firstAdmin,
      provisionalUntil: u.provisionalUntil?.toISOString() ?? null,
      lastVisitedAt: u.lastVisitedAt?.toISOString() ?? null,
    })),
  };
}

// ─── Lifecycle transitions ──────────────────────────────────────────────────

export async function transitionTenantStatus(input: {
  orgId: string;
  next: "suspended" | "archived" | "active";
  reason?: string;
  audit: AuditContext;
}): Promise<
  { ok: true; status: string } | { ok: false; error: "tenant_not_found" | "invalid_transition" }
> {
  if (!isUuid(input.orgId)) return { ok: false, error: "tenant_not_found" };

  const [tenant] = await db
    .select({
      id: tenants.id,
      status: tenants.status,
      createdVia: tenants.createdVia,
      verifiedAt: tenants.verifiedAt,
    })
    .from(tenants)
    .where(eq(tenants.id, input.orgId))
    .limit(1);
  if (!tenant) return { ok: false, error: "tenant_not_found" };

  // Prevent reactivating a self-serve tenant that never verified — the CHECK
  // constraint would block it anyway, but a nicer error helps the UI.
  if (
    input.next === "active" &&
    tenant.createdVia === "self_serve" &&
    !tenant.verifiedAt &&
    tenant.status !== "provisional"
  ) {
    return { ok: false, error: "invalid_transition" };
  }

  await withTenantContext(input.orgId, async (tx) => {
    await tx
      .update(tenants)
      .set({ status: input.next, updatedAt: new Date() })
      .where(eq(tenants.id, input.orgId));

    await tx.insert(outboxEvents).values({
      tenantId: input.orgId,
      type: `tenant.${input.next}`,
      payload: { tenantId: input.orgId, reason: input.reason },
    });

    await tx.insert(auditLogs).values({
      orgId: input.orgId,
      userId: input.audit.actorUserId,
      action: `tenant.${input.next}`,
      resourceType: "tenant",
      resourceId: input.orgId,
      oldValues: { status: tenant.status },
      newValues: { status: input.next, reason: input.reason },
      ipHash: input.audit.ipHash,
      userAgent: input.audit.userAgent,
    });
  });

  return { ok: true, status: input.next };
}

// ─── Audit drawer ───────────────────────────────────────────────────────────

export async function listRecentAudit(orgId: string, limit = 50) {
  if (!isUuid(orgId)) return [];
  const rows = await db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      resourceType: auditLogs.resourceType,
      resourceId: auditLogs.resourceId,
      userId: auditLogs.userId,
      newValues: auditLogs.newValues,
      oldValues: auditLogs.oldValues,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .where(eq(auditLogs.orgId, orgId))
    .orderBy(sql`${auditLogs.createdAt} DESC`)
    .limit(limit);
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

// ─── Invite first enterprise user helper (super-admin) ─────────────────────

export async function inviteFirstEnterpriseUser(input: {
  orgId: string;
  email: string;
  audit: AuditContext;
}): Promise<{ ok: true; token: string } | { ok: false; error: "tenant_not_found" }> {
  if (!isUuid(input.orgId)) return { ok: false, error: "tenant_not_found" };
  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, input.orgId))
    .limit(1);
  if (!tenant) return { ok: false, error: "tenant_not_found" };

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const result = await withTenantContext(input.orgId, async (tx) => {
    const [row] = await tx
      .insert(invitations)
      .values({
        orgId: input.orgId,
        email: input.email.trim().toLowerCase(),
        role: "org_admin",
        purpose: "team_invite",
        expiresAt,
      })
      .returning({ id: invitations.id, token: invitations.token });

    await tx.insert(outboxEvents).values({
      tenantId: input.orgId,
      type: "tenant.first_admin_invited",
      payload: { tenantId: input.orgId, invitationId: row?.id },
    });
    return row;
  });
  // biome-ignore lint/style/noNonNullAssertion: returning() yields one row
  return { ok: true, token: result!.token };
}

// ─── Error helpers ──────────────────────────────────────────────────────────

function isUniqueViolation(err: unknown, constraintHint?: RegExp): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; constraint?: string; message?: string };
  if (e.code !== "23505") return false;
  if (!constraintHint) return true;
  return constraintHint.test(e.constraint ?? "") || constraintHint.test(e.message ?? "");
}

function isKeycloakConflict(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { status?: number };
  return e.status === 409;
}

function isKeycloakNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { status?: number };
  return e.status === 404;
}

// ─── Test helpers — batched cleanup for integration teardown ────────────────

/** Delete tenants and cascade dependencies. Owner role only (used in tests). */
export async function hardDeleteTenants(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(tenants).where(inArray(tenants.id, ids));
}
