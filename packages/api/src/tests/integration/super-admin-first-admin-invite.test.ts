/**
 * Integration coverage for the super-admin → first-admin invite flow
 * (issue #147). The structural twin is `team-invitations.test.ts`; this
 * file asserts the super-admin-scoped routes and the first-admin discriminator
 * (`invitedById IS NULL`).
 */

import { randomUUID } from "node:crypto";
import { auditLogs, invitations, outboxEvents, tenants, users } from "@givernance/shared/schema";
import { inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";
import { redis } from "../../lib/redis.js";
import { createServer } from "../../server.js";
import { authHeader, signToken } from "../helpers/auth.js";

let app: FastifyInstance;

const fixtureSlugs = new Set<string>();

interface Fixture {
  orgId: string;
  slug: string;
  superAdminToken: string;
}

async function makeFixture(): Promise<Fixture> {
  const orgId = randomUUID();
  const slug = `first-admin-${randomUUID().slice(0, 8)}`;
  fixtureSlugs.add(slug);

  await db.execute(
    sql`INSERT INTO tenants (id, name, slug, status, created_via)
        VALUES (${orgId}, ${`First Admin Test ${slug}`}, ${slug}, 'provisional', 'enterprise')`,
  );

  // Super-admin tokens still carry an `org_id` claim (the auth plugin
  // requires one); the discriminator is the `super_admin` realm role.
  // Using a fresh UUID keeps the token decoupled from the target tenant.
  const superAdminToken = signToken(app, {
    sub: `super-${randomUUID().slice(0, 8)}`,
    org_id: randomUUID(),
    email: `super+${slug}@givernance.app`,
    role: "viewer",
    realm_access: { roles: ["super_admin"] },
  });

  return { orgId, slug, superAdminToken };
}

beforeAll(async () => {
  app = await createServer();
  await app.ready();
});

beforeEach(async () => {
  const keys = await redis.keys("*rate-limit*");
  if (keys.length > 0) await redis.del(...keys);
});

afterAll(async () => {
  await app.close();
});

afterEach(async () => {
  if (fixtureSlugs.size === 0) return;
  const slugList = [...fixtureSlugs];
  const rows = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(inArray(tenants.slug, slugList));
  const ids = rows.map((r) => r.id);
  if (ids.length > 0) {
    await db.transaction(async (tx) => {
      // audit_logs has an immutability trigger; replica role bypasses it
      // for the test cleanup (matches signup.test.ts and team-invitations.test.ts).
      await tx.execute(sql`SET LOCAL session_replication_role = 'replica'`);
      await tx.delete(auditLogs).where(inArray(auditLogs.orgId, ids));
      await tx.delete(outboxEvents).where(inArray(outboxEvents.tenantId, ids));
      await tx.delete(invitations).where(inArray(invitations.orgId, ids));
      await tx.delete(users).where(inArray(users.orgId, ids));
      await tx.delete(tenants).where(inArray(tenants.id, ids));
    });
  }
  fixtureSlugs.clear();
});

describe("POST /v1/superadmin/tenants/:id/first-admin-invitations", () => {
  it("creates a first-admin invitation and returns the raw token", async () => {
    const f = await makeFixture();
    const email = `first-admin+${f.slug}@example.org`;

    const res = await app.inject({
      method: "POST",
      url: `/v1/superadmin/tenants/${f.orgId}/first-admin-invitations`,
      headers: authHeader(f.superAdminToken),
      payload: { email },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{
      data: { invitationId: string; invitationToken: string; expiresAt: string };
    }>();
    expect(body.data.invitationToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(body.data.invitationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    // Row written with the first-admin discriminator (invited_by IS NULL).
    const { rows: invRows } = await db.execute<{
      role: string;
      purpose: string;
      invited_by_id: string | null;
    }>(sql`SELECT role, purpose, invited_by_id FROM invitations WHERE org_id = ${f.orgId}`);
    expect(invRows).toHaveLength(1);
    expect(invRows[0]).toMatchObject({
      role: "org_admin",
      purpose: "team_invite",
      invited_by_id: null,
    });

    // Outbox carries the discriminating event type.
    const { rows: events } = await db.execute<{ type: string }>(
      sql`SELECT type FROM outbox_events WHERE tenant_id = ${f.orgId}`,
    );
    expect(events.map((e) => e.type)).toContain("tenant.first_admin_invited");
  });

  it("returns 404 for an unknown tenant id", async () => {
    const f = await makeFixture();
    const res = await app.inject({
      method: "POST",
      url: `/v1/superadmin/tenants/${randomUUID()}/first-admin-invitations`,
      headers: authHeader(f.superAdminToken),
      payload: { email: "anyone@example.org" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 409 once the first-admin invitation has been accepted", async () => {
    const f = await makeFixture();
    const create = await app.inject({
      method: "POST",
      url: `/v1/superadmin/tenants/${f.orgId}/first-admin-invitations`,
      headers: authHeader(f.superAdminToken),
      payload: { email: `accepted+${f.slug}@example.org` },
    });
    expect(create.statusCode).toBe(201);
    const { invitationId } = create.json<{
      data: { invitationId: string };
    }>().data;

    // Simulate the accept-side flip without going through the public route.
    await db.execute(sql`UPDATE invitations SET accepted_at = now() WHERE id = ${invitationId}`);

    const second = await app.inject({
      method: "POST",
      url: `/v1/superadmin/tenants/${f.orgId}/first-admin-invitations`,
      headers: authHeader(f.superAdminToken),
      payload: { email: `accepted+${f.slug}@example.org` },
    });
    expect(second.statusCode).toBe(409);
  });

  it("returns 401 for unauthenticated callers", async () => {
    const f = await makeFixture();
    const res = await app.inject({
      method: "POST",
      url: `/v1/superadmin/tenants/${f.orgId}/first-admin-invitations`,
      payload: { email: "anyone@example.org" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 404 when the caller lacks the super_admin realm role", async () => {
    const f = await makeFixture();
    const orgAdminToken = signToken(app, {
      sub: `org-admin-${randomUUID().slice(0, 8)}`,
      org_id: f.orgId,
      role: "org_admin",
      realm_access: { roles: [] },
    });
    const res = await app.inject({
      method: "POST",
      url: `/v1/superadmin/tenants/${f.orgId}/first-admin-invitations`,
      headers: authHeader(orgAdminToken),
      payload: { email: "anyone@example.org" },
    });
    expect(res.statusCode).toBe(404);
  });

  // ─── Per-invitation locale (issue #153 follow-up) ─────────────────────────

  it("super-admin pre-pick persists on invitations.locale and stamps the outbox payload", async () => {
    const f = await makeFixture();
    const email = `locale-pick+${f.slug}@example.org`;
    const res = await app.inject({
      method: "POST",
      url: `/v1/superadmin/tenants/${f.orgId}/first-admin-invitations`,
      headers: authHeader(f.superAdminToken),
      payload: { email, locale: "en" },
    });
    expect(res.statusCode).toBe(201);
    const { invitationId } = res.json<{ data: { invitationId: string } }>().data;

    const { rows: inv } = await db.execute<{ locale: string | null }>(
      sql`SELECT locale FROM invitations WHERE id = ${invitationId}`,
    );
    expect(inv[0]?.locale).toBe("en");

    const { rows: events } = await db.execute<{ payload: { locale?: string } }>(
      sql`SELECT payload FROM outbox_events
          WHERE tenant_id = ${f.orgId}
            AND type = 'tenant.first_admin_invited'
            AND payload->>'invitationId' = ${invitationId}
          LIMIT 1`,
    );
    expect(events[0]?.payload?.locale).toBe("en");
  });

  it("omitting locale leaves invitations.locale NULL and falls back to tenant default", async () => {
    const f = await makeFixture();
    const email = `locale-default+${f.slug}@example.org`;
    const res = await app.inject({
      method: "POST",
      url: `/v1/superadmin/tenants/${f.orgId}/first-admin-invitations`,
      headers: authHeader(f.superAdminToken),
      payload: { email },
    });
    expect(res.statusCode).toBe(201);
    const { invitationId } = res.json<{ data: { invitationId: string } }>().data;

    const { rows: inv } = await db.execute<{ locale: string | null }>(
      sql`SELECT locale FROM invitations WHERE id = ${invitationId}`,
    );
    expect(inv[0]?.locale).toBeNull();

    const { rows: events } = await db.execute<{ payload: { locale?: string } }>(
      sql`SELECT payload FROM outbox_events
          WHERE tenant_id = ${f.orgId}
            AND type = 'tenant.first_admin_invited'
            AND payload->>'invitationId' = ${invitationId}
          LIMIT 1`,
    );
    // Tenant default is 'fr' (column DEFAULT for enterprise tenants).
    expect(events[0]?.payload?.locale).toBe("fr");
  });

  it("rejects an unsupported locale with 400", async () => {
    const f = await makeFixture();
    const res = await app.inject({
      method: "POST",
      url: `/v1/superadmin/tenants/${f.orgId}/first-admin-invitations`,
      headers: authHeader(f.superAdminToken),
      payload: { email: `bad-locale+${f.slug}@example.org`, locale: "de" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /v1/superadmin/tenants/:id/first-admin-invitations/:invitationId/resend", () => {
  it("rotates the token, re-emits the outbox event, and returns the fresh token", async () => {
    const f = await makeFixture();
    const create = await app.inject({
      method: "POST",
      url: `/v1/superadmin/tenants/${f.orgId}/first-admin-invitations`,
      headers: authHeader(f.superAdminToken),
      payload: { email: `resend+${f.slug}@example.org` },
    });
    expect(create.statusCode).toBe(201);
    const { invitationId, invitationToken: original } = create.json<{
      data: { invitationId: string; invitationToken: string };
    }>().data;

    const resend = await app.inject({
      method: "POST",
      url: `/v1/superadmin/tenants/${f.orgId}/first-admin-invitations/${invitationId}/resend`,
      headers: authHeader(f.superAdminToken),
    });
    expect(resend.statusCode).toBe(200);
    const { invitationToken: rotated } = resend.json<{
      data: { invitationToken: string };
    }>().data;
    expect(rotated).not.toBe(original);

    const { rows: events } = await db.execute<{ type: string }>(
      sql`SELECT type FROM outbox_events WHERE tenant_id = ${f.orgId}`,
    );
    expect(events.filter((e) => e.type === "tenant.first_admin_invited")).toHaveLength(2);
  });

  it("resend propagates the stored invitations.locale (issue #153 follow-up)", async () => {
    // Tenant default is fr; super-admin pre-picked en at create time.
    // Resend should re-emit with locale='en', not flip back to the
    // tenant default — resend semantics is "redeliver the same content
    // with a fresh token", not "re-pick the language".
    const f = await makeFixture();
    const create = await app.inject({
      method: "POST",
      url: `/v1/superadmin/tenants/${f.orgId}/first-admin-invitations`,
      headers: authHeader(f.superAdminToken),
      payload: { email: `resend-locale+${f.slug}@example.org`, locale: "en" },
    });
    expect(create.statusCode).toBe(201);
    const { invitationId } = create.json<{ data: { invitationId: string } }>().data;

    const resend = await app.inject({
      method: "POST",
      url: `/v1/superadmin/tenants/${f.orgId}/first-admin-invitations/${invitationId}/resend`,
      headers: authHeader(f.superAdminToken),
    });
    expect(resend.statusCode).toBe(200);

    // Two outbox events for this invitation; the resent one carries
    // resent:true and the stored locale.
    const { rows } = await db.execute<{ payload: { resent?: boolean; locale?: string } }>(
      sql`SELECT payload FROM outbox_events
          WHERE tenant_id = ${f.orgId}
            AND type = 'tenant.first_admin_invited'
            AND payload->>'invitationId' = ${invitationId}
          ORDER BY created_at ASC`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.payload?.resent).toBeUndefined();
    expect(rows[0]?.payload?.locale).toBe("en");
    expect(rows[1]?.payload?.resent).toBe(true);
    expect(rows[1]?.payload?.locale).toBe("en");
  });

  it("returns 404 for an unknown invitation id", async () => {
    const f = await makeFixture();
    const res = await app.inject({
      method: "POST",
      url: `/v1/superadmin/tenants/${f.orgId}/first-admin-invitations/${randomUUID()}/resend`,
      headers: authHeader(f.superAdminToken),
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 409 when the invitation has already been accepted", async () => {
    const f = await makeFixture();
    const create = await app.inject({
      method: "POST",
      url: `/v1/superadmin/tenants/${f.orgId}/first-admin-invitations`,
      headers: authHeader(f.superAdminToken),
      payload: { email: `accepted-resend+${f.slug}@example.org` },
    });
    const { invitationId } = create.json<{
      data: { invitationId: string };
    }>().data;
    await db.execute(sql`UPDATE invitations SET accepted_at = now() WHERE id = ${invitationId}`);

    const res = await app.inject({
      method: "POST",
      url: `/v1/superadmin/tenants/${f.orgId}/first-admin-invitations/${invitationId}/resend`,
      headers: authHeader(f.superAdminToken),
    });
    expect(res.statusCode).toBe(409);
  });
});

describe("DELETE /v1/superadmin/tenants/:id/first-admin-invitations/:invitationId", () => {
  it("hard-deletes a pending invitation", async () => {
    const f = await makeFixture();
    const create = await app.inject({
      method: "POST",
      url: `/v1/superadmin/tenants/${f.orgId}/first-admin-invitations`,
      headers: authHeader(f.superAdminToken),
      payload: { email: `cancel+${f.slug}@example.org` },
    });
    const { invitationId } = create.json<{
      data: { invitationId: string };
    }>().data;

    const cancel = await app.inject({
      method: "DELETE",
      url: `/v1/superadmin/tenants/${f.orgId}/first-admin-invitations/${invitationId}`,
      headers: authHeader(f.superAdminToken),
    });
    expect(cancel.statusCode).toBe(204);

    const { rows } = await db.execute<{ id: string }>(
      sql`SELECT id FROM invitations WHERE id = ${invitationId}`,
    );
    expect(rows).toHaveLength(0);
  });

  it("returns 404 for an unknown invitation id", async () => {
    const f = await makeFixture();
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/superadmin/tenants/${f.orgId}/first-admin-invitations/${randomUUID()}`,
      headers: authHeader(f.superAdminToken),
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 409 when the invitation has already been accepted", async () => {
    const f = await makeFixture();
    const create = await app.inject({
      method: "POST",
      url: `/v1/superadmin/tenants/${f.orgId}/first-admin-invitations`,
      headers: authHeader(f.superAdminToken),
      payload: { email: `cancel-accepted+${f.slug}@example.org` },
    });
    const { invitationId } = create.json<{
      data: { invitationId: string };
    }>().data;
    await db.execute(sql`UPDATE invitations SET accepted_at = now() WHERE id = ${invitationId}`);

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/superadmin/tenants/${f.orgId}/first-admin-invitations/${invitationId}`,
      headers: authHeader(f.superAdminToken),
    });
    expect(res.statusCode).toBe(409);
  });
});

// Cross-tenant scoping regression — review MEDIUM finding on PR #154.
// Both `resendFirstEnterpriseInvitation` and `revokeFirstEnterpriseInvitation`
// match on `(invitations.id, invitations.orgId)`; this asserts that passing
// the WRONG tenant id alongside a real invitation id 404s instead of acting
// on the foreign row. Otherwise a super-admin (or compromised session)
// could rotate / revoke invitations across tenants by id-guessing.
describe("Cross-tenant scoping", () => {
  it("resend 404s when :id is not the owning tenant", async () => {
    const owner = await makeFixture();
    const intruder = await makeFixture();
    const create = await app.inject({
      method: "POST",
      url: `/v1/superadmin/tenants/${owner.orgId}/first-admin-invitations`,
      headers: authHeader(owner.superAdminToken),
      payload: { email: `cross-tenant-resend+${owner.slug}@example.org` },
    });
    const { invitationId } = create.json<{
      data: { invitationId: string };
    }>().data;

    const res = await app.inject({
      method: "POST",
      url: `/v1/superadmin/tenants/${intruder.orgId}/first-admin-invitations/${invitationId}/resend`,
      headers: authHeader(intruder.superAdminToken),
    });
    expect(res.statusCode).toBe(404);

    // The owner's row is untouched.
    const { rows } = await db.execute<{ token: string }>(
      sql`SELECT token FROM invitations WHERE id = ${invitationId}`,
    );
    expect(rows).toHaveLength(1);
  });

  it("revoke 404s when :id is not the owning tenant", async () => {
    const owner = await makeFixture();
    const intruder = await makeFixture();
    const create = await app.inject({
      method: "POST",
      url: `/v1/superadmin/tenants/${owner.orgId}/first-admin-invitations`,
      headers: authHeader(owner.superAdminToken),
      payload: { email: `cross-tenant-revoke+${owner.slug}@example.org` },
    });
    const { invitationId } = create.json<{
      data: { invitationId: string };
    }>().data;

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/superadmin/tenants/${intruder.orgId}/first-admin-invitations/${invitationId}`,
      headers: authHeader(intruder.superAdminToken),
    });
    expect(res.statusCode).toBe(404);

    const { rows } = await db.execute<{ id: string }>(
      sql`SELECT id FROM invitations WHERE id = ${invitationId}`,
    );
    expect(rows).toHaveLength(1);
  });
});

describe("GET /v1/superadmin/tenants/:id/detail (firstAdminInvitation surface)", () => {
  it("exposes a pending first-admin invitation in the detail response", async () => {
    const f = await makeFixture();
    const email = `detail+${f.slug}@example.org`;
    await app.inject({
      method: "POST",
      url: `/v1/superadmin/tenants/${f.orgId}/first-admin-invitations`,
      headers: authHeader(f.superAdminToken),
      payload: { email },
    });

    const res = await app.inject({
      method: "GET",
      url: `/v1/superadmin/tenants/${f.orgId}/detail`,
      headers: authHeader(f.superAdminToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        firstAdminInvitation: {
          email: string;
          status: "pending" | "accepted" | "expired";
        } | null;
      };
    }>();
    expect(body.data.firstAdminInvitation).toMatchObject({
      email: email.toLowerCase(),
      status: "pending",
    });
  });

  it("returns null for tenants with no first-admin invitation on file", async () => {
    const f = await makeFixture();
    const res = await app.inject({
      method: "GET",
      url: `/v1/superadmin/tenants/${f.orgId}/detail`,
      headers: authHeader(f.superAdminToken),
    });
    expect(res.statusCode).toBe(200);
    expect(
      res.json<{ data: { firstAdminInvitation: unknown } }>().data.firstAdminInvitation,
    ).toBeNull();
  });

  // Regression for the RLS-silently-empty-list bug surfaced during PR #154
  // QA: `users`, `tenant_domains`, and `audit_logs` are FORCE RLS, and the
  // detail query runs as the `givernance_app` role. Without `withTenantContext`
  // setting `app.current_organization_id`, the policy's
  // `org_id = current_setting(...)::uuid` clause evaluates against `NULL` and
  // every row is filtered out — a super-admin saw zero users for every
  // tenant on the detail page.
  it("returns the tenant's users (RLS GUC scoped via withTenantContext)", async () => {
    const f = await makeFixture();
    const userId = randomUUID();
    await db.execute(
      sql`INSERT INTO users (id, org_id, email, first_name, last_name, role, keycloak_id)
          VALUES (${userId}, ${f.orgId}, ${`member+${f.slug}@example.org`}, 'Member', 'One', 'org_admin', ${`kc-member-${f.slug}`})`,
    );

    const res = await app.inject({
      method: "GET",
      url: `/v1/superadmin/tenants/${f.orgId}/detail`,
      headers: authHeader(f.superAdminToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        users: Array<{ email: string; role: string }>;
      };
    }>();
    expect(body.data.users).toHaveLength(1);
    expect(body.data.users[0]).toMatchObject({
      email: `member+${f.slug}@example.org`,
      role: "org_admin",
    });
  });
});
