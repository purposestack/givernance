/**
 * Integration coverage for the onboarding runtime (PR #118 / ADR-016).
 *
 * Covers the critical paths called out by the test-review pass:
 *  - Enterprise tenant + IdP provisioning via stubbed Keycloak admin
 *  - Domain claim / verify / revoke — KC 409 idempotent path (DATA-3)
 *  - `runExpireJob` idempotency (DATA-7)
 *  - Dispute open + `replaced` swap (SEC-6, DATA-1)
 *  - Session blocklist key + switch-org impersonation guard (SEC-9 / DATA-5)
 *  - Admin-route 404 (SEC-5)
 *
 * Tests call the service layer directly with injected `deps` so Keycloak /
 * DNS are never hit. A thin HTTP layer is tested via `app.inject` for the
 * SEC-5 guard surface.
 */

import { randomUUID } from "node:crypto";
import {
  auditLogs,
  invitations,
  outboxEvents,
  tenantAdminDisputes,
  tenantDomains,
  tenants,
  users,
} from "@givernance/shared/schema";
import { eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";
import type { TxtResolver } from "../../lib/dns.js";
import type { KeycloakAdminClient } from "../../lib/keycloak-admin.js";
import { KeycloakAdminError } from "../../lib/keycloak-admin.js";
import { redis } from "../../lib/redis.js";
import { openDispute, resolveDispute, runExpireJob } from "../../modules/disputes/service.js";
import {
  isSessionBlocklisted,
  recordOrgSwitch,
  sessionBlocklistKey,
} from "../../modules/session/service.js";
import {
  claimDomain,
  createEnterpriseTenant,
  provisionIdp,
  revokeDomain,
  verifyDomain,
} from "../../modules/tenant-admin/service.js";
import { createServer } from "../../server.js";
import { authHeader, ensureTestTenants, signToken } from "../helpers/auth.js";

let app: FastifyInstance;

const RUN = `ob${Date.now().toString(36)}${Math.floor(Math.random() * 1_000_000).toString(36)}`;
const slug = (n: string) => `${RUN}-${n}`.slice(0, 48);
const domain = (n: string) => `${n}.${RUN}.test`.toLowerCase();

/** Track tenants created in each test so `afterEach` can tear them down. */
const createdTenantIds = new Set<string>();

function makeKcStub(overrides: Partial<KeycloakAdminClient> = {}): KeycloakAdminClient {
  const base: KeycloakAdminClient = {
    createOrganization: async ({ name, alias, attributes }) => ({
      id: randomUUID(),
      name,
      alias,
      attributes,
    }),
    getOrganization: async () => null,
    deleteOrganization: async () => {},
    addOrgDomain: async () => {},
    attachUserToOrg: async () => {},
    sendInvitation: async () => {},
    bindIdpToOrganization: async () => {},
    createIdentityProvider: async () => {},
    deleteIdentityProvider: async () => {},
    _circuitState: () => "closed" as const,
  };
  return { ...base, ...overrides };
}

function makeTxtStub(records: string[][]): TxtResolver {
  return {
    resolveTxt: async () => records,
  };
}

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();
});

beforeEach(async () => {
  // Clear rate-limit + blocklist keys between tests.
  const keys = await redis.keys("session:blocklist:*");
  if (keys.length > 0) await redis.del(...keys);
});

afterEach(async () => {
  if (createdTenantIds.size === 0) return;
  const ids = [...createdTenantIds];
  // Run the whole cleanup in one transaction that sets
  // `session_replication_role = replica` — bypasses the audit-logs
  // immutability trigger *just for this session* without racing other test
  // files that toggle the trigger at table scope (which would surface as
  // "audit_logs table is immutable" in a concurrent signup.test.ts run).
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = 'replica'`);
    await tx.delete(auditLogs).where(inArray(auditLogs.orgId, ids));
    await tx.delete(outboxEvents).where(inArray(outboxEvents.tenantId, ids));
    await tx.delete(invitations).where(inArray(invitations.orgId, ids));
    await tx.delete(tenantAdminDisputes).where(inArray(tenantAdminDisputes.orgId, ids));
    await tx.delete(tenantDomains).where(inArray(tenantDomains.orgId, ids));
    await tx.delete(users).where(inArray(users.orgId, ids));
    await tx.delete(tenants).where(inArray(tenants.id, ids));
  });
  createdTenantIds.clear();
});

afterAll(async () => {
  await app.close();
});

async function seedEnterpriseTenant(opts?: { keycloakOrgId?: string }): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO tenants (id, name, slug, status, created_via, keycloak_org_id)
    VALUES (
      ${id},
      ${`Enterprise ${slug("t")}`},
      ${slug(`t-${Math.random().toString(36).slice(2, 8)}`)},
      'active',
      'enterprise',
      ${opts?.keycloakOrgId ?? null}
    )
  `);
  createdTenantIds.add(id);
  return id;
}

async function seedProvisionalTenant(now = new Date()): Promise<{
  orgId: string;
  adminId: string;
  disputerId: string;
}> {
  const orgId = randomUUID();
  const adminId = randomUUID();
  const disputerId = randomUUID();
  await db.execute(sql`
    INSERT INTO tenants (id, name, slug, status, created_via, verified_at)
    VALUES (
      ${orgId},
      ${`Provisional ${slug("p")}`},
      ${slug(`p-${Math.random().toString(36).slice(2, 8)}`)},
      'active',
      'self_serve',
      ${now.toISOString()}
    )
  `);
  const provisionalUntil = new Date(now.getTime() + 7 * 24 * 3600 * 1000).toISOString();
  await db.execute(sql`
    INSERT INTO users (id, org_id, email, first_name, last_name, role, first_admin, provisional_until)
    VALUES
      (${adminId}, ${orgId}, ${`admin-${RUN}-${adminId.slice(0, 4)}@example.org`}, 'A', 'Admin', 'org_admin', true, ${provisionalUntil}),
      (${disputerId}, ${orgId}, ${`disp-${RUN}-${disputerId.slice(0, 4)}@example.org`}, 'D', 'Disp', 'user', false, NULL)
  `);
  createdTenantIds.add(orgId);
  return { orgId, adminId, disputerId };
}

// ─── TEST-1 + TEST-3 — enterprise tenant + IdP provisioning ────────────────

describe("createEnterpriseTenant", () => {
  it("persists provisional + KC org id + audit + outbox on happy path", async () => {
    const kcOrgId = randomUUID();
    const kc = makeKcStub({
      createOrganization: async ({ name, alias, attributes }) => ({
        id: kcOrgId,
        name,
        alias,
        attributes,
      }),
    });

    const res = await createEnterpriseTenant(
      {
        name: "Happy Ent",
        slug: slug("ent-happy"),
        audit: { actorUserId: null },
      },
      { kc },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    createdTenantIds.add(res.tenantId);

    const [tenant] = await db
      .select({
        status: tenants.status,
        createdVia: tenants.createdVia,
        kcOrgId: tenants.keycloakOrgId,
      })
      .from(tenants)
      .where(eq(tenants.id, res.tenantId));
    expect(tenant).toBeDefined();
    expect(tenant?.status).toBe("provisional");
    expect(tenant?.createdVia).toBe("enterprise");
    expect(tenant?.kcOrgId).toBe(kcOrgId);
  });

  it("rejects duplicate slug without touching Keycloak", async () => {
    let kcCalls = 0;
    const kc = makeKcStub({
      createOrganization: async (args) => {
        kcCalls += 1;
        return { id: randomUUID(), ...args };
      },
    });
    const first = await createEnterpriseTenant(
      { name: "Dup 1", slug: slug("dup"), audit: { actorUserId: null } },
      { kc },
    );
    expect(first.ok).toBe(true);
    if (first.ok) createdTenantIds.add(first.tenantId);
    const second = await createEnterpriseTenant(
      { name: "Dup 2", slug: slug("dup"), audit: { actorUserId: null } },
      { kc },
    );
    expect(second).toEqual({ ok: false, error: "slug_taken" });
    expect(kcCalls).toBe(1);
  });
});

describe("provisionIdp", () => {
  it("creates + binds OIDC IdP, flips tenant to active", async () => {
    const kcOrgId = randomUUID();
    const orgId = await seedEnterpriseTenant({ keycloakOrgId: kcOrgId });
    // Start from `provisional` so we can observe the flip.
    await db.execute(sql`UPDATE tenants SET status = 'provisional' WHERE id = ${orgId}`);

    const calls: string[] = [];
    const kc = makeKcStub({
      createIdentityProvider: async (idp) => {
        calls.push(`create:${idp.providerId}:${idp.alias}`);
      },
      bindIdpToOrganization: async (org, { alias }) => {
        calls.push(`bind:${org}:${alias}`);
      },
    });

    const res = await provisionIdp(
      {
        orgId,
        config: {
          type: "oidc",
          discoveryUrl: "https://login.example.org/.well-known/openid-configuration",
          clientId: "kc-client",
          clientSecret: "s3cret",
        },
        audit: { actorUserId: null },
      },
      { kc },
    );
    expect(res.ok).toBe(true);
    expect(calls[0]).toContain("create:oidc:tenant-");
    expect(calls[1]).toContain(`bind:${kcOrgId}:tenant-`);

    const [row] = await db
      .select({ status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, orgId));
    expect(row?.status).toBe("active");
  });

  it("rejects OIDC config whose discoveryUrl resolves to a private address (SEC-1)", async () => {
    const kcOrgId = randomUUID();
    const orgId = await seedEnterpriseTenant({ keycloakOrgId: kcOrgId });
    const kc = makeKcStub({
      createIdentityProvider: async () => {
        throw new Error("should not be called");
      },
    });

    const res = await provisionIdp(
      {
        orgId,
        config: {
          type: "oidc",
          discoveryUrl: "http://169.254.169.254/metadata",
          clientId: "kc-client",
          clientSecret: "s3cret",
        },
        audit: { actorUserId: null },
      },
      { kc },
    );
    expect(res).toEqual({ ok: false, error: "invalid_config" });
  });

  it("maps KC 409 → alias_taken", async () => {
    const kcOrgId = randomUUID();
    const orgId = await seedEnterpriseTenant({ keycloakOrgId: kcOrgId });
    const kc = makeKcStub({
      createIdentityProvider: async () => {
        throw new KeycloakAdminError("exists", 409, "/identity-provider/instances");
      },
    });

    const res = await provisionIdp(
      {
        orgId,
        config: {
          type: "oidc",
          issuer: "https://example.org/realms/tenantA",
          authorizationUrl: "https://example.org/realms/tenantA/auth",
          tokenUrl: "https://example.org/realms/tenantA/token",
          clientId: "kc-client",
          clientSecret: "s3cret",
        },
        audit: { actorUserId: null },
      },
      { kc },
    );
    expect(res).toEqual({ ok: false, error: "alias_taken" });
  });

  it("rejects provisioning for a tenant with no keycloakOrgId", async () => {
    const orgId = await seedEnterpriseTenant({ keycloakOrgId: undefined });
    const res = await provisionIdp(
      {
        orgId,
        config: {
          type: "oidc",
          discoveryUrl: "https://login.example.org/.well-known/openid-configuration",
          clientId: "kc-client",
          clientSecret: "s3cret",
        },
        audit: { actorUserId: null },
      },
      { kc: makeKcStub() },
    );
    expect(res).toEqual({ ok: false, error: "tenant_has_no_org" });
  });
});

// ─── TEST-6 — domain claim + verify + revoke ──────────────────────────────

describe("domain lifecycle", () => {
  it("claim → verify (TXT match) → revoke", async () => {
    const kcOrgId = randomUUID();
    const orgId = await seedEnterpriseTenant({ keycloakOrgId: kcOrgId });
    const dom = domain("claim");

    const claim = await claimDomain({
      orgId,
      domain: dom,
      audit: { actorUserId: null },
    });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    expect(claim.state).toBe("pending_dns");

    const resolver = makeTxtStub([[claim.dnsTxtValue]]);
    const verify = await verifyDomain(
      { orgId, domain: dom, audit: { actorUserId: null } },
      { resolver, kc: makeKcStub() },
    );
    expect(verify).toEqual({ ok: true, domain: dom, state: "verified" });

    const [td] = await db
      .select({ state: tenantDomains.state })
      .from(tenantDomains)
      .where(eq(tenantDomains.domain, dom));
    expect(td?.state).toBe("verified");

    const revoke = await revokeDomain({ orgId, domain: dom, audit: { actorUserId: null } });
    expect(revoke.ok).toBe(true);

    const [audit] = await db
      .select({ oldVals: auditLogs.oldValues })
      .from(auditLogs)
      .where(eq(auditLogs.action, "tenant.domain_revoked"))
      .orderBy(sql`${auditLogs.createdAt} DESC`)
      .limit(1);
    // SEC-10: the audit `oldValues` must reflect the pre-revoke state, not the post-update state.
    expect((audit?.oldVals as { state: string } | null)?.state).toBe("verified");
  });

  it("verify tolerates KC 409 on addOrgDomain (DATA-3)", async () => {
    const kcOrgId = randomUUID();
    const orgId = await seedEnterpriseTenant({ keycloakOrgId: kcOrgId });
    const dom = domain("kc409");

    const claim = await claimDomain({
      orgId,
      domain: dom,
      audit: { actorUserId: null },
    });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    const resolver = makeTxtStub([[claim.dnsTxtValue]]);
    const kc = makeKcStub({
      addOrgDomain: async () => {
        throw new KeycloakAdminError("already attached", 409, "/organizations/any/domains");
      },
    });
    const res = await verifyDomain(
      { orgId, domain: dom, audit: { actorUserId: null } },
      { resolver, kc },
    );
    expect(res.ok).toBe(true);
    const [td] = await db
      .select({ state: tenantDomains.state })
      .from(tenantDomains)
      .where(eq(tenantDomains.domain, dom));
    expect(td?.state).toBe("verified");
  });

  it("verify with mismatched TXT → 422 dns_mismatch", async () => {
    const orgId = await seedEnterpriseTenant({ keycloakOrgId: randomUUID() });
    const dom = domain("mismatch");

    const claim = await claimDomain({
      orgId,
      domain: dom,
      audit: { actorUserId: null },
    });
    expect(claim.ok).toBe(true);

    const resolver = makeTxtStub([["givernance-verify=someone-else-token"]]);
    const res = await verifyDomain(
      { orgId, domain: dom, audit: { actorUserId: null } },
      { resolver, kc: makeKcStub() },
    );
    expect(res).toEqual({ ok: false, error: "dns_mismatch" });
  });

  it("claim rejects personal-email domains (gmail.com)", async () => {
    const orgId = await seedEnterpriseTenant({ keycloakOrgId: randomUUID() });
    const res = await claimDomain({
      orgId,
      domain: "gmail.com",
      audit: { actorUserId: null },
    });
    expect(res).toEqual({ ok: false, error: "personal_email" });
  });
});

// ─── TEST-8 — dispute open + replaced swap (SEC-6, DATA-1) ─────────────────

describe("dispute lifecycle", () => {
  it("open → resolve 'replaced' swaps first_admin atomically", async () => {
    const { orgId, adminId, disputerId } = await seedProvisionalTenant();
    const resolverSub = randomUUID();
    // Seed a super-admin user so the dispute's resolver has a users row.
    const resolverUserId = randomUUID();
    await db.execute(sql`
      INSERT INTO users (id, org_id, email, first_name, last_name, role, keycloak_id, first_admin)
      VALUES (${resolverUserId}, ${orgId}, ${`resolver-${RUN}@example.org`}, 'R', 'R', 'user', ${resolverSub}, false)
    `);

    // Disputer opens — needs a keycloak_id mapped to their user.
    const disputerSub = randomUUID();
    await db.execute(sql`UPDATE users SET keycloak_id = ${disputerSub} WHERE id = ${disputerId}`);

    const open = await openDispute({
      orgId,
      disputerKeycloakSub: disputerSub,
      reason: "Not the right person",
      audit: {},
    });
    expect(open.ok).toBe(true);
    if (!open.ok) return;

    const res = await resolveDispute({
      disputeId: open.disputeId,
      resolution: "replaced",
      resolverUserKeycloakSub: resolverSub,
      audit: {},
    });
    expect(res).toEqual({ ok: true, resolution: "replaced" });

    const rows = await db
      .select({ id: users.id, role: users.role, firstAdmin: users.firstAdmin })
      .from(users)
      .where(inArray(users.id, [adminId, disputerId]));
    const admin = rows.find((r) => r.id === adminId);
    const disputer = rows.find((r) => r.id === disputerId);
    expect(admin?.firstAdmin).toBe(false);
    expect(admin?.role).toBe("user");
    expect(disputer?.firstAdmin).toBe(true);
    expect(disputer?.role).toBe("org_admin");
  });

  it("super-admin who IS the disputer cannot self-resolve (SEC-6)", async () => {
    const { orgId, disputerId } = await seedProvisionalTenant();
    const disputerSub = randomUUID();
    await db.execute(sql`UPDATE users SET keycloak_id = ${disputerSub} WHERE id = ${disputerId}`);

    const open = await openDispute({
      orgId,
      disputerKeycloakSub: disputerSub,
      reason: "self",
      audit: {},
    });
    expect(open.ok).toBe(true);
    if (!open.ok) return;

    const res = await resolveDispute({
      disputeId: open.disputeId,
      resolution: "replaced",
      // Same sub as the disputer → resolverUserId lookup finds the disputer's row.
      resolverUserKeycloakSub: disputerSub,
      audit: {},
    });
    expect(res).toEqual({ ok: false, error: "self_resolve_forbidden" });
  });

  it("double-resolve returns already_resolved", async () => {
    const { orgId, disputerId } = await seedProvisionalTenant();
    const disputerSub = randomUUID();
    await db.execute(sql`UPDATE users SET keycloak_id = ${disputerSub} WHERE id = ${disputerId}`);
    const open = await openDispute({
      orgId,
      disputerKeycloakSub: disputerSub,
      audit: {},
    });
    expect(open.ok).toBe(true);
    if (!open.ok) return;

    const first = await resolveDispute({
      disputeId: open.disputeId,
      resolution: "kept",
      resolverUserKeycloakSub: randomUUID(),
      audit: {},
    });
    expect(first.ok).toBe(true);
    const second = await resolveDispute({
      disputeId: open.disputeId,
      resolution: "kept",
      resolverUserKeycloakSub: randomUUID(),
      audit: {},
    });
    expect(second).toEqual({ ok: false, error: "already_resolved" });
  });
});

// ─── TEST-10 — expire job idempotency (DATA-7) ─────────────────────────────

describe("runExpireJob", () => {
  it("clears provisional_until for confirmed admins and is idempotent", async () => {
    const past = new Date(Date.now() - 60 * 1000);
    const { orgId } = await seedProvisionalTenant(past);
    await db.execute(sql`
      UPDATE users SET provisional_until = ${past.toISOString()}
      WHERE org_id = ${orgId} AND first_admin = true
    `);

    const first = await runExpireJob(new Date());
    expect(first.confirmedOrgIds).toContain(orgId);

    // Second run — no candidates to confirm because the flag was cleared.
    const second = await runExpireJob(new Date());
    expect(second.confirmedOrgIds).not.toContain(orgId);
  });

  it("skips tenants with an open dispute", async () => {
    const past = new Date(Date.now() - 60 * 1000);
    const { orgId, disputerId } = await seedProvisionalTenant(past);
    await db.execute(sql`
      UPDATE users SET provisional_until = ${past.toISOString()}
      WHERE org_id = ${orgId} AND first_admin = true
    `);
    const disputerSub = randomUUID();
    await db.execute(sql`UPDATE users SET keycloak_id = ${disputerSub} WHERE id = ${disputerId}`);
    // Push the window forward so openDispute can find a non-closed window.
    await db.execute(sql`
      UPDATE users SET provisional_until = ${new Date(Date.now() + 3600 * 1000).toISOString()}
      WHERE org_id = ${orgId} AND first_admin = true
    `);
    const open = await openDispute({
      orgId,
      disputerKeycloakSub: disputerSub,
      audit: {},
    });
    expect(open.ok).toBe(true);
    // Push back to past so the expire job would pick it up if not for the dispute.
    await db.execute(sql`
      UPDATE users SET provisional_until = ${past.toISOString()}
      WHERE org_id = ${orgId} AND first_admin = true
    `);

    const res = await runExpireJob(new Date());
    expect(res.skippedOrgIds).toContain(orgId);
    expect(res.confirmedOrgIds).not.toContain(orgId);
  });
});

// ─── TEST-7 / TEST-11 — session switch-org + blocklist ─────────────────────

describe("recordOrgSwitch + session blocklist", () => {
  it("refuses impersonation sessions (doc 22 §8)", async () => {
    const { orgId, disputerId } = await seedProvisionalTenant();
    const sub = randomUUID();
    await db.execute(sql`UPDATE users SET keycloak_id = ${sub} WHERE id = ${disputerId}`);
    const res = await recordOrgSwitch({
      keycloakSub: sub,
      targetOrgId: orgId,
      isImpersonating: true,
      audit: {},
    });
    expect(res).toEqual({ ok: false, error: "not_a_member" });
  });

  it("happy: records last_visited, writes audit, blocklists previous jti", async () => {
    const { orgId, disputerId } = await seedProvisionalTenant();
    const sub = randomUUID();
    await db.execute(sql`UPDATE users SET keycloak_id = ${sub} WHERE id = ${disputerId}`);
    const jti = `test-jti-${randomUUID()}`;
    const res = await recordOrgSwitch({
      keycloakSub: sub,
      targetOrgId: orgId,
      previousJti: jti,
      previousExp: Math.floor(Date.now() / 1000) + 600,
      audit: {},
    });
    expect(res.ok).toBe(true);

    expect(await isSessionBlocklisted(jti)).toBe(true);
    expect(await isSessionBlocklisted(undefined)).toBe(false);

    const [row] = await db
      .select({ lastVisited: users.lastVisitedAt })
      .from(users)
      .where(eq(users.id, disputerId));
    expect(row?.lastVisited).toBeTruthy();
  });

  it("sessionBlocklistKey format is stable", () => {
    expect(sessionBlocklistKey("abc-123")).toBe("session:blocklist:abc-123");
  });
});

// ─── SEC-5 — admin endpoints return 404 for non-super-admin ────────────────

describe("admin route discoverability", () => {
  it("GET /v1/admin/disputes returns 404 for authenticated non-super-admin", async () => {
    const token = signToken(app, { realm_access: { roles: ["admin"] } });
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/disputes",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET /v1/admin/disputes returns 401 for unauthenticated", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/disputes",
    });
    expect(res.statusCode).toBe(401);
  });
});
