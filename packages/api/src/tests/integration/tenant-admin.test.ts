import { randomUUID } from "node:crypto";
import { TRACEPARENT_RE } from "@givernance/shared/lib/trace-context";
import { auditLogs, outboxEvents, tenantDomains, tenants, users } from "@givernance/shared/schema";
import { eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../../server.js";
import { authHeader, seedTenantUser, signToken } from "../helpers/auth.js";
import { db } from "../helpers/db.js";

let app: FastifyInstance;

const seededTenantIds = new Set<string>();

function makeSuperAdminToken(): string {
  return signToken(app, {
    sub: `super-${randomUUID().slice(0, 8)}`,
    org_id: randomUUID(),
    email: `super+${randomUUID().slice(0, 8)}@givernance.app`,
    role: "viewer",
    realm_access: { roles: ["super_admin"] },
  });
}

async function seedTenant(input: {
  name: string;
  slug: string;
  createdVia: "self_serve" | "enterprise";
  createdAt?: string;
  verifiedAt?: string | null;
  ownershipConfirmedAt?: string | null;
}): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO tenants (
      id,
      name,
      slug,
      status,
      created_via,
      verified_at,
      ownership_confirmed_at,
      created_at,
      updated_at
    ) VALUES (
      ${id},
      ${input.name},
      ${input.slug},
      'active',
      ${input.createdVia},
      ${input.verifiedAt ?? null},
      ${input.ownershipConfirmedAt ?? null},
      ${input.createdAt ?? new Date().toISOString()},
      ${input.createdAt ?? new Date().toISOString()}
    )
  `);
  seededTenantIds.add(id);
  return id;
}

beforeAll(async () => {
  app = await createServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

afterEach(async () => {
  if (seededTenantIds.size === 0) return;
  const ids = [...seededTenantIds];
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = 'replica'`);
    await tx.delete(auditLogs).where(inArray(auditLogs.orgId, ids));
    await tx.delete(outboxEvents).where(inArray(outboxEvents.tenantId, ids));
    await tx.delete(tenantDomains).where(inArray(tenantDomains.orgId, ids));
    await tx.delete(users).where(inArray(users.orgId, ids));
    await tx.delete(tenants).where(inArray(tenants.id, ids));
  });
  seededTenantIds.clear();
});

describe("GET /v1/superadmin/tenants", () => {
  it("sorts tenants from API query params", async () => {
    const token = makeSuperAdminToken();
    await seedTenant({
      name: "Zulu Relief",
      slug: `zulu-${randomUUID().slice(0, 6)}`,
      createdVia: "enterprise",
      createdAt: "2026-04-20T10:00:00.000Z",
    });
    await seedTenant({
      name: "Alpha Relief",
      slug: `alpha-${randomUUID().slice(0, 6)}`,
      createdVia: "enterprise",
      createdAt: "2026-04-21T10:00:00.000Z",
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/superadmin/tenants?q=relief&sort=name&order=asc",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ name: string }> }>();
    expect(body.data.slice(0, 2).map((row) => row.name)).toEqual(["Alpha Relief", "Zulu Relief"]);
  });
});

describe("GET /v1/superadmin/tenants — q combines with the other filters (issue #616)", () => {
  it("status=active&q=<slug of a suspended tenant> returns nothing", async () => {
    const token = makeSuperAdminToken();
    const suspendedSlug = `susp-${randomUUID().slice(0, 8)}`;
    const id = await seedTenant({
      name: "Dormant Org",
      slug: suspendedSlug,
      createdVia: "enterprise",
    });
    await db.update(tenants).set({ status: "suspended" }).where(eq(tenants.id, id));

    const active = await app.inject({
      method: "GET",
      url: `/v1/superadmin/tenants?status=active&q=${suspendedSlug}`,
      headers: authHeader(token),
    });
    expect(active.statusCode).toBe(200);
    expect(active.json<{ data: unknown[] }>().data).toEqual([]);

    // Sanity: the same search under the matching status does find it.
    const suspended = await app.inject({
      method: "GET",
      url: `/v1/superadmin/tenants?status=suspended&q=${suspendedSlug}`,
      headers: authHeader(token),
    });
    expect(suspended.json<{ data: Array<{ id: string }> }>().data.map((t) => t.id)).toEqual([id]);
  });
});

describe("tenant suspension is enforced on the tenant's users (issue #616)", () => {
  async function seedTenantWithMember() {
    const orgId = await seedTenant({
      name: "Lifecycle Org",
      slug: `life-${randomUUID().slice(0, 8)}`,
      createdVia: "enterprise",
    });
    const sub = randomUUID();
    await seedTenantUser(orgId, { sub });
    const memberToken = signToken(app, { sub, org_id: orgId, email: `test-${sub}@example.org` });
    return { orgId, memberToken };
  }

  function callAsMember(memberToken: string, url = "/v1/constituents") {
    return app.inject({ method: "GET", url, headers: authHeader(memberToken) });
  }

  function lifecycle(superToken: string, orgId: string, action: string) {
    return app.inject({
      method: "POST",
      url: `/v1/superadmin/tenants/${orgId}/lifecycle`,
      headers: authHeader(superToken),
      payload: { action, reason: "issue #616 test" },
    });
  }

  it.each([
    "suspend",
    "archive",
  ] as const)("%s → member 401s at once; activate → member works again", async (action) => {
    const superToken = makeSuperAdminToken();
    const { orgId, memberToken } = await seedTenantWithMember();

    // Warms the positive active-membership cache — the rejection below
    // therefore also proves the transition invalidated it (no 30 s wait).
    expect((await callAsMember(memberToken)).statusCode).toBe(200);

    expect((await lifecycle(superToken, orgId, action)).statusCode).toBe(200);

    const rejected = await callAsMember(memberToken);
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json<{ detail: string }>().detail).toBe("Account no longer active.");
    // Served from the negative cache the second time — same outcome.
    expect((await callAsMember(memberToken)).statusCode).toBe(401);

    // Org picker stays reachable so a multi-org member can switch away.
    expect((await callAsMember(memberToken, "/v1/users/me/organizations")).statusCode).toBe(200);

    // Super-admin back office is unaffected by the tenant's status.
    const detail = await app.inject({
      method: "GET",
      url: `/v1/superadmin/tenants/${orgId}/detail`,
      headers: authHeader(superToken),
    });
    expect(detail.statusCode).toBe(200);

    expect((await lifecycle(superToken, orgId, "activate")).statusCode).toBe(200);
    expect((await callAsMember(memberToken)).statusCode).toBe(200);
  });

  it("does not affect members of other tenants", async () => {
    const superToken = makeSuperAdminToken();
    const { orgId } = await seedTenantWithMember();
    const other = await seedTenantWithMember();

    expect((await lifecycle(superToken, orgId, "suspend")).statusCode).toBe(200);
    expect((await callAsMember(other.memberToken)).statusCode).toBe(200);
  });
});

describe("POST /v1/superadmin/tenants/:id/confirm-ownership", () => {
  it("confirms ownership for self-serve tenants and writes an audit log", async () => {
    const token = makeSuperAdminToken();
    const tenantId = await seedTenant({
      name: "Self Serve Review",
      slug: `self-serve-${randomUUID().slice(0, 6)}`,
      createdVia: "self_serve",
      verifiedAt: "2026-04-27T09:00:00.000Z",
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/superadmin/tenants/${tenantId}/confirm-ownership`,
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { ownershipConfirmedAt: string } }>();
    expect(body.data.ownershipConfirmedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const [tenant] = await db
      .select({ ownershipConfirmedAt: tenants.ownershipConfirmedAt })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    expect(tenant?.ownershipConfirmedAt).not.toBeNull();

    const { rows: audit } = await db.execute<{ action: string }>(
      sql`SELECT action FROM audit_logs WHERE org_id = ${tenantId} ORDER BY created_at DESC LIMIT 1`,
    );
    expect(audit[0]?.action).toBe("tenant.ownership_confirmed");
  });

  it("rejects enterprise tenants", async () => {
    const token = makeSuperAdminToken();
    const tenantId = await seedTenant({
      name: "Enterprise Review",
      slug: `enterprise-${randomUUID().slice(0, 6)}`,
      createdVia: "enterprise",
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/superadmin/tenants/${tenantId}/confirm-ownership`,
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(409);
  });
});

// ─── Trace-context on the AuditContext outbox variant (issues #55 / #575) ───
//
// The tenant-admin module is the only place where `buildOutboxMetadata` flows
// through `AuditContext.outboxMetadata` (stamped once in `auditFromRequest`)
// instead of being passed to the service directly. These tests pin that
// variant end-to-end over HTTP: if `auditFromRequest` dropped the field or a
// service insert removed `metadata:`, the outbox row would come back null.
describe("POST /v1/tenants/:orgId/domains — outbox trace metadata", () => {
  async function latestDomainClaimedMetadata(tenantId: string) {
    const { rows } = await db.execute<{
      metadata: { traceparent?: string; tracestate?: string } | null;
    }>(
      sql`SELECT metadata FROM outbox_events
          WHERE tenant_id = ${tenantId} AND type = 'tenant.domain_claimed'
          ORDER BY created_at DESC LIMIT 1`,
    );
    expect(rows.length).toBe(1);
    return rows[0]?.metadata ?? null;
  }

  it("preserves a valid incoming traceparent + tracestate through to the outbox row", async () => {
    const token = makeSuperAdminToken();
    const tenantId = await seedTenant({
      name: "Trace Preserve",
      verifiedAt: "2026-04-27T09:00:00.000Z",
      slug: `trace-p-${randomUUID().slice(0, 6)}`,
      createdVia: "self_serve",
    });

    const incomingTraceparent = `00-${"ab".repeat(16)}-${"cd".repeat(8)}-01`;
    const incomingTracestate = "vendor=opaque-value,other=42";

    const res = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/domains`,
      headers: {
        ...authHeader(token),
        traceparent: incomingTraceparent,
        tracestate: incomingTracestate,
      },
      payload: { domain: `trace-${randomUUID().slice(0, 8)}.example.org` },
    });

    expect(res.statusCode).toBe(201);
    const metadata = await latestDomainClaimedMetadata(tenantId);
    expect(metadata?.traceparent).toBe(incomingTraceparent);
    expect(metadata?.tracestate).toBe(incomingTracestate);
  });

  it("synthesises a traceparent when no header is sent (and stores no tracestate)", async () => {
    const token = makeSuperAdminToken();
    const tenantId = await seedTenant({
      name: "Trace Synthesise",
      verifiedAt: "2026-04-27T09:00:00.000Z",
      slug: `trace-s-${randomUUID().slice(0, 6)}`,
      createdVia: "self_serve",
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/domains`,
      headers: authHeader(token),
      payload: { domain: `trace-${randomUUID().slice(0, 8)}.example.org` },
    });

    expect(res.statusCode).toBe(201);
    const metadata = await latestDomainClaimedMetadata(tenantId);
    expect(metadata?.traceparent).toMatch(TRACEPARENT_RE);
    expect(metadata?.tracestate).toBeUndefined();
  });

  it("drops an invalid traceparent header and synthesises instead", async () => {
    const token = makeSuperAdminToken();
    const tenantId = await seedTenant({
      name: "Trace Invalid",
      verifiedAt: "2026-04-27T09:00:00.000Z",
      slug: `trace-i-${randomUUID().slice(0, 6)}`,
      createdVia: "self_serve",
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/domains`,
      headers: {
        ...authHeader(token),
        traceparent: "not-a-traceparent",
        tracestate: "vendor=value",
      },
      payload: { domain: `trace-${randomUUID().slice(0, 8)}.example.org` },
    });

    expect(res.statusCode).toBe(201);
    const metadata = await latestDomainClaimedMetadata(tenantId);
    expect(metadata?.traceparent).toMatch(TRACEPARENT_RE);
    expect(metadata?.traceparent).not.toBe("not-a-traceparent");
    // tracestate is only meaningful alongside a preserved upstream
    // traceparent — the synthesise branch must not carry it.
    expect(metadata?.tracestate).toBeUndefined();
  });
});
