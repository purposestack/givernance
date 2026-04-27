import { randomUUID } from "node:crypto";
import { auditLogs, tenants } from "@givernance/shared/schema";
import { eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";
import { createServer } from "../../server.js";
import { authHeader, signToken } from "../helpers/auth.js";

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
