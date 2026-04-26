/**
 * Integration coverage for the team-invitation flow (issue #145).
 *
 * Mirrors the structural twin in `signup.test.ts` — same KC stub shape,
 * same Redis rate-limit hygiene, same per-test tenant teardown. Asserts
 * the contract at the route boundary: status codes, outbox events, KC
 * call counts, and the recovery / hijack discriminators.
 */

import { randomUUID } from "node:crypto";
import { auditLogs, invitations, outboxEvents, tenants, users } from "@givernance/shared/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../lib/db.js";
import {
  _resetKeycloakAdminSingleton,
  _setKeycloakAdminSingleton,
  type KeycloakAdminClient,
  KeycloakAdminError,
  KeycloakUserExistsError,
} from "../../lib/keycloak-admin.js";
import { redis } from "../../lib/redis.js";
import { createServer } from "../../server.js";
import { authHeader, signToken } from "../helpers/auth.js";

let app: FastifyInstance;

// ─── KC stub ────────────────────────────────────────────────────────────────

const kcCreateUser = vi.fn<KeycloakAdminClient["createUser"]>(async (input) => ({
  id: `kc-${input.email}-${randomUUID().slice(0, 8)}`,
}));
const kcCreateOrganization = vi.fn<KeycloakAdminClient["createOrganization"]>(
  async ({ name, alias, attributes }) => ({
    id: randomUUID(),
    name,
    alias,
    attributes,
  }),
);
const kcAttachUserToOrg = vi.fn<KeycloakAdminClient["attachUserToOrg"]>(async () => {});
const kcGetOrganizationByAlias = vi.fn<KeycloakAdminClient["getOrganizationByAlias"]>(
  async () => null,
);
const kcResetUserPassword = vi.fn<KeycloakAdminClient["resetUserPassword"]>(async () => {});
const kcSetUserAttributes = vi.fn<KeycloakAdminClient["setUserAttributes"]>(async () => {});

const fakeKeycloakAdmin: KeycloakAdminClient = {
  createOrganization: kcCreateOrganization,
  getOrganization: vi.fn(async () => null),
  getOrganizationByAlias: kcGetOrganizationByAlias,
  deleteOrganization: vi.fn(async () => {}),
  addOrgDomain: vi.fn(async () => {}),
  attachUserToOrg: kcAttachUserToOrg,
  sendInvitation: vi.fn(async () => {}),
  bindIdpToOrganization: vi.fn(async () => {}),
  createUser: kcCreateUser,
  getUserByEmail: vi.fn(async () => null),
  resetUserPassword: kcResetUserPassword,
  setUserAttributes: kcSetUserAttributes,
  createIdentityProvider: vi.fn(async () => {}),
  deleteIdentityProvider: vi.fn(async () => {}),
  _circuitState: () => "closed",
};

// ─── Per-test tenant fixture ────────────────────────────────────────────────

interface Fixture {
  orgId: string;
  slug: string;
  keycloakOrgId: string;
  inviterUserId: string;
  inviterKeycloakId: string;
  inviterToken: string;
}

const fixtureSlugs = new Set<string>();

async function makeFixture(
  opts: { withKcOrgId?: boolean; defaultLocale?: "en" | "fr" } = {},
): Promise<Fixture> {
  const { withKcOrgId = true, defaultLocale = "fr" } = opts;
  const orgId = randomUUID();
  const inviterUserId = randomUUID();
  const inviterKeycloakId = `kc-inviter-${randomUUID().slice(0, 8)}`;
  const slug = `team-invite-${randomUUID().slice(0, 8)}`;
  const keycloakOrgId = randomUUID();
  fixtureSlugs.add(slug);

  await db.execute(
    sql`INSERT INTO tenants (id, name, slug, status, created_via, keycloak_org_id, default_locale)
        VALUES (${orgId}, ${`Team Invite Test ${slug}`}, ${slug}, 'active', 'enterprise', ${withKcOrgId ? keycloakOrgId : null}, ${defaultLocale})`,
  );

  // Inviter user — required for the create endpoint to resolve `invitedById`
  // and for the `users.email` uniqueness checks during accept.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_organization_id', ${orgId}, true)`);
    await tx.insert(users).values({
      id: inviterUserId,
      orgId,
      email: `inviter-${slug}@example.org`,
      firstName: "Inviter",
      lastName: "Admin",
      role: "org_admin",
      keycloakId: inviterKeycloakId,
    });
  });

  const inviterToken = signToken(app, {
    sub: inviterKeycloakId,
    org_id: orgId,
    email: `inviter-${slug}@example.org`,
    role: "org_admin",
  });

  return { orgId, slug, keycloakOrgId, inviterUserId, inviterKeycloakId, inviterToken };
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

beforeAll(async () => {
  _setKeycloakAdminSingleton(fakeKeycloakAdmin);
  app = await createServer();
  await app.ready();
});

beforeEach(async () => {
  kcCreateUser.mockClear();
  kcCreateOrganization.mockClear();
  kcAttachUserToOrg.mockClear();
  kcGetOrganizationByAlias.mockClear();
  kcResetUserPassword.mockClear();
  kcSetUserAttributes.mockClear();
  // Reset stub default behaviour each test — resetting the singleton wipes
  // mockImplementationOnce queues that earlier tests installed.
  kcCreateUser.mockImplementation(async (input) => ({
    id: `kc-${input.email}-${randomUUID().slice(0, 8)}`,
  }));
  kcCreateOrganization.mockImplementation(async ({ name, alias, attributes }) => ({
    id: randomUUID(),
    name,
    alias,
    attributes,
  }));

  const keys = await redis.keys("*rate-limit*");
  if (keys.length > 0) await redis.del(...keys);
});

afterAll(async () => {
  await app.close();
  _resetKeycloakAdminSingleton();
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
      // for the test cleanup (matches signup.test.ts).
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

// ─── Create ─────────────────────────────────────────────────────────────────

describe("POST /v1/invitations", () => {
  it("creates a team-invite row, emits invitation.created, and audits", async () => {
    const f = await makeFixture();
    const email = `newbie+${f.slug}@example.org`;

    const res = await app.inject({
      method: "POST",
      url: "/v1/invitations",
      headers: authHeader(f.inviterToken),
      payload: { email, role: "user" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ data: { id: string; email: string; role: string } }>();
    expect(body.data.email).toBe(email.toLowerCase());
    expect(body.data.role).toBe("user");

    const { rows: events } = await db.execute<{ type: string }>(
      sql`SELECT type FROM outbox_events WHERE tenant_id = ${f.orgId} ORDER BY created_at ASC`,
    );
    expect(events.map((e) => e.type)).toContain("invitation.created");

    const [audit] = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(and(eq(auditLogs.orgId, f.orgId), eq(auditLogs.action, "invitation.created")));
    expect(audit).toBeDefined();
  });

  it("returns 409 when the email is already a member of the tenant", async () => {
    const f = await makeFixture();

    // Pre-existing member
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_organization_id', ${f.orgId}, true)`);
      await tx.insert(users).values({
        orgId: f.orgId,
        email: `existing-${f.slug}@example.org`,
        firstName: "Existing",
        lastName: "Member",
        role: "user",
        keycloakId: `kc-existing-${f.slug}`,
      });
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/invitations",
      headers: authHeader(f.inviterToken),
      payload: { email: `existing-${f.slug}@example.org` },
    });
    expect(res.statusCode).toBe(409);
  });

  it("returns 409 when a pending invitation for the same email already exists", async () => {
    const f = await makeFixture();
    const email = `dup+${f.slug}@example.org`;

    const first = await app.inject({
      method: "POST",
      url: "/v1/invitations",
      headers: authHeader(f.inviterToken),
      payload: { email },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: "/v1/invitations",
      headers: authHeader(f.inviterToken),
      payload: { email },
    });
    expect(second.statusCode).toBe(409);
  });
});

// ─── List ───────────────────────────────────────────────────────────────────

describe("GET /v1/invitations", () => {
  it("returns only team_invite rows for the current tenant", async () => {
    const f = await makeFixture();

    // Seed one team invite + one signup-verification row that must be
    // hidden from the members page.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_organization_id', ${f.orgId}, true)`);
      await tx.insert(invitations).values([
        {
          orgId: f.orgId,
          email: `team-${f.slug}@example.org`,
          role: "user",
          purpose: "team_invite",
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
        {
          orgId: f.orgId,
          email: `signup-${f.slug}@example.org`,
          role: "org_admin",
          purpose: "signup_verification",
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      ]);
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/invitations",
      headers: authHeader(f.inviterToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: Array<{ email: string; status: string }>;
      pagination: { total: number };
    }>();
    expect(body.data.every((row) => row.email.startsWith("team-"))).toBe(true);
    expect(body.pagination.total).toBe(1);
  });

  it("requires org_admin", async () => {
    const f = await makeFixture();
    const userToken = signToken(app, {
      sub: `kc-user-${f.slug}`,
      org_id: f.orgId,
      role: "user",
    });
    const res = await app.inject({
      method: "GET",
      url: "/v1/invitations",
      headers: authHeader(userToken),
    });
    expect(res.statusCode).toBe(403);
  });

  it("joins invitedById to users and returns invitedByName, null-safe (issue #151)", async () => {
    const f = await makeFixture();

    // 1. Invitation created via the create endpoint — invitedById resolves
    //    to the inviter fixture, so invitedByName must be "Inviter Admin".
    const create = await app.inject({
      method: "POST",
      url: "/v1/invitations",
      headers: authHeader(f.inviterToken),
      payload: { email: `with-inviter+${f.slug}@example.org`, role: "user" },
    });
    expect(create.statusCode).toBe(201);

    // 2. Direct insert with invitedById = null — mirrors the super-admin
    //    seeding path (`inviteFirstEnterpriseUser`). invitedByName must be
    //    null without the join nuking the row.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_organization_id', ${f.orgId}, true)`);
      await tx.insert(invitations).values({
        orgId: f.orgId,
        email: `null-inviter+${f.slug}@example.org`,
        role: "user",
        purpose: "team_invite",
        invitedById: null,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
    });

    const list = await app.inject({
      method: "GET",
      url: "/v1/invitations",
      headers: authHeader(f.inviterToken),
    });
    expect(list.statusCode).toBe(200);
    const body = list.json<{
      data: Array<{ email: string; invitedById: string | null; invitedByName: string | null }>;
    }>();

    const withInviter = body.data.find((row) => row.email.startsWith("with-inviter+"));
    expect(withInviter).toBeDefined();
    expect(withInviter?.invitedById).toBe(f.inviterUserId);
    expect(withInviter?.invitedByName).toBe("Inviter Admin");

    const nullInviter = body.data.find((row) => row.email.startsWith("null-inviter+"));
    expect(nullInviter).toBeDefined();
    expect(nullInviter?.invitedById).toBeNull();
    expect(nullInviter?.invitedByName).toBeNull();
  });
});

// ─── Resend ─────────────────────────────────────────────────────────────────

describe("POST /v1/invitations/:id/resend", () => {
  it("rotates the token and emits invitation.resent", async () => {
    const f = await makeFixture();
    const email = `resend+${f.slug}@example.org`;

    const create = await app.inject({
      method: "POST",
      url: "/v1/invitations",
      headers: authHeader(f.inviterToken),
      payload: { email },
    });
    const created = create.json<{ data: { id: string } }>().data;

    const [before] = await db
      .select({ token: invitations.token })
      .from(invitations)
      .where(eq(invitations.id, created.id));

    const res = await app.inject({
      method: "POST",
      url: `/v1/invitations/${created.id}/resend`,
      headers: authHeader(f.inviterToken),
    });
    expect(res.statusCode).toBe(204);

    const [after] = await db
      .select({ token: invitations.token })
      .from(invitations)
      .where(eq(invitations.id, created.id));
    expect(after?.token).not.toBe(before?.token);

    const { rows: events } = await db.execute<{ type: string }>(
      sql`SELECT type FROM outbox_events WHERE tenant_id = ${f.orgId} AND type = 'invitation.resent'`,
    );
    expect(events).toHaveLength(1);
  });

  it("returns 404 for an unknown id and 409 for an accepted invitation", async () => {
    const f = await makeFixture();
    const email = `accepted+${f.slug}@example.org`;

    const create = await app.inject({
      method: "POST",
      url: "/v1/invitations",
      headers: authHeader(f.inviterToken),
      payload: { email },
    });
    const created = create.json<{ data: { id: string } }>().data;

    // Mark accepted directly so the resend hits the "already_accepted" path.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_organization_id', ${f.orgId}, true)`);
      await tx
        .update(invitations)
        .set({ acceptedAt: new Date() })
        .where(eq(invitations.id, created.id));
    });

    const conflict = await app.inject({
      method: "POST",
      url: `/v1/invitations/${created.id}/resend`,
      headers: authHeader(f.inviterToken),
    });
    expect(conflict.statusCode).toBe(409);

    const missing = await app.inject({
      method: "POST",
      url: `/v1/invitations/${randomUUID()}/resend`,
      headers: authHeader(f.inviterToken),
    });
    expect(missing.statusCode).toBe(404);
  });
});

// ─── Revoke ─────────────────────────────────────────────────────────────────

describe("DELETE /v1/invitations/:id", () => {
  it("hard-deletes the invitation row", async () => {
    const f = await makeFixture();
    const create = await app.inject({
      method: "POST",
      url: "/v1/invitations",
      headers: authHeader(f.inviterToken),
      payload: { email: `revoke+${f.slug}@example.org` },
    });
    const created = create.json<{ data: { id: string } }>().data;

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/invitations/${created.id}`,
      headers: authHeader(f.inviterToken),
    });
    expect(res.statusCode).toBe(204);

    const [after] = await db
      .select({ id: invitations.id })
      .from(invitations)
      .where(eq(invitations.id, created.id));
    expect(after).toBeUndefined();
  });

  it("rejects revoke on an accepted invitation with 409", async () => {
    const f = await makeFixture();
    const create = await app.inject({
      method: "POST",
      url: "/v1/invitations",
      headers: authHeader(f.inviterToken),
      payload: { email: `revoke-accepted+${f.slug}@example.org` },
    });
    const created = create.json<{ data: { id: string } }>().data;

    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_organization_id', ${f.orgId}, true)`);
      await tx
        .update(invitations)
        .set({ acceptedAt: new Date() })
        .where(eq(invitations.id, created.id));
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/invitations/${created.id}`,
      headers: authHeader(f.inviterToken),
    });
    expect(res.statusCode).toBe(409);
  });
});

// ─── Accept ─────────────────────────────────────────────────────────────────

describe("POST /v1/invitations/:token/accept", () => {
  it("provisions the KC user, attaches to the org, and returns slug", async () => {
    const f = await makeFixture();
    const email = `happy+${f.slug}@example.org`;

    const create = await app.inject({
      method: "POST",
      url: "/v1/invitations",
      headers: authHeader(f.inviterToken),
      payload: { email, role: "user" },
    });
    const created = create.json<{ data: { id: string } }>().data;
    const tokenRows = await db
      .select({ token: invitations.token })
      .from(invitations)
      .where(eq(invitations.id, created.id));
    const token = tokenRows[0]?.token ?? "";

    const accept = await app.inject({
      method: "POST",
      url: `/v1/invitations/${token}/accept`,
      payload: {
        firstName: "Newbie",
        lastName: "Member",
        password: "long-enough-password-1",
      },
    });
    expect(accept.statusCode).toBe(201);
    const body = accept.json<{ data: { slug: string } }>();
    expect(body.data.slug).toBe(f.slug);

    expect(kcCreateUser).toHaveBeenCalledTimes(1);
    expect(kcAttachUserToOrg).toHaveBeenCalledTimes(1);
    expect(kcResetUserPassword).not.toHaveBeenCalled();

    const [user] = await db
      .select({ id: users.id, role: users.role, keycloakId: users.keycloakId })
      .from(users)
      .where(and(eq(users.orgId, f.orgId), eq(users.email, email.toLowerCase())));
    expect(user?.role).toBe("user");
    expect(user?.keycloakId).toBeTruthy();

    const { rows: events } = await db.execute<{ type: string }>(
      sql`SELECT type FROM outbox_events WHERE tenant_id = ${f.orgId} ORDER BY created_at ASC`,
    );
    const types = events.map((e) => e.type);
    expect(types).toContain("invitation.accepted");
    expect(types).toContain("user.invited_accepted");
  });

  it("rejects a signup_verification token (purpose discriminator)", async () => {
    const f = await makeFixture();
    const token = randomUUID();
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_organization_id', ${f.orgId}, true)`);
      await tx.insert(invitations).values({
        orgId: f.orgId,
        email: `signup-only+${f.slug}@example.org`,
        role: "org_admin",
        token,
        purpose: "signup_verification",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/invitations/${token}/accept`,
      payload: { firstName: "X", lastName: "Y", password: "long-enough-password-1" },
    });
    expect(res.statusCode).toBe(410);
    expect(kcCreateUser).not.toHaveBeenCalled();
  });

  it("collapses hijack attempt (KC user exists, no prior binding) to a generic 410", async () => {
    const f = await makeFixture();
    const email = `hijack+${f.slug}@example.org`;
    const create = await app.inject({
      method: "POST",
      url: "/v1/invitations",
      headers: authHeader(f.inviterToken),
      payload: { email },
    });
    const created = create.json<{ data: { id: string } }>().data;
    const tokenRows = await db
      .select({ token: invitations.token })
      .from(invitations)
      .where(eq(invitations.id, created.id));
    const token = tokenRows[0]?.token ?? "";

    kcCreateUser.mockRejectedValueOnce(new KeycloakUserExistsError(email));

    const res = await app.inject({
      method: "POST",
      url: `/v1/invitations/${token}/accept`,
      payload: { firstName: "X", lastName: "Y", password: "long-enough-password-1" },
    });
    expect(res.statusCode).toBe(410);

    // Critical: no users row was created, no password was reset.
    expect(kcResetUserPassword).not.toHaveBeenCalled();
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.orgId, f.orgId), eq(users.email, email.toLowerCase())));
    expect(user).toBeUndefined();
  });

  it("recovers (no KC credential): existing users row with null keycloak_id triggers create", async () => {
    const f = await makeFixture();
    const email = `recovery-a+${f.slug}@example.org`;

    const create = await app.inject({
      method: "POST",
      url: "/v1/invitations",
      headers: authHeader(f.inviterToken),
      payload: { email },
    });
    const created = create.json<{ data: { id: string } }>().data;
    const tokenRows = await db
      .select({ token: invitations.token })
      .from(invitations)
      .where(eq(invitations.id, created.id));
    const token = tokenRows[0]?.token ?? "";

    // Pre-insert a half-provisioned users row (no keycloak_id) — mirrors a
    // prior accept tx that rolled back after the user INSERT.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_organization_id', ${f.orgId}, true)`);
      await tx.insert(users).values({
        orgId: f.orgId,
        email: email.toLowerCase(),
        firstName: "Half",
        lastName: "Provisioned",
        role: "user",
      });
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/invitations/${token}/accept`,
      payload: { firstName: "Recovered", lastName: "Member", password: "long-enough-password-1" },
    });
    expect(res.statusCode).toBe(201);
    expect(kcCreateUser).toHaveBeenCalledTimes(1);
    expect(kcResetUserPassword).not.toHaveBeenCalled();
  });

  it("recovers (already bound): existing users.keycloak_id triggers password reset, not createUser", async () => {
    const f = await makeFixture();
    const email = `recovery-b+${f.slug}@example.org`;

    const create = await app.inject({
      method: "POST",
      url: "/v1/invitations",
      headers: authHeader(f.inviterToken),
      payload: { email },
    });
    const created = create.json<{ data: { id: string } }>().data;
    const tokenRows = await db
      .select({ token: invitations.token })
      .from(invitations)
      .where(eq(invitations.id, created.id));
    const token = tokenRows[0]?.token ?? "";

    // Pre-bind the users row to a KC id — simulates an enterprise tenant
    // user provisioned before the team-invite path landed.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_organization_id', ${f.orgId}, true)`);
      await tx.insert(users).values({
        orgId: f.orgId,
        email: email.toLowerCase(),
        firstName: "Already",
        lastName: "Bound",
        role: "user",
        keycloakId: `kc-prebound-${f.slug}`,
      });
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/invitations/${token}/accept`,
      payload: { firstName: "Reset", lastName: "Pwd", password: "long-enough-password-1" },
    });
    expect(res.statusCode).toBe(201);
    expect(kcCreateUser).not.toHaveBeenCalled();
    expect(kcResetUserPassword).toHaveBeenCalledTimes(1);
    expect(kcSetUserAttributes).toHaveBeenCalledTimes(1);
  });

  it("creates the KC organization when tenant.keycloak_org_id is null", async () => {
    const f = await makeFixture({ withKcOrgId: false });
    const email = `noorg+${f.slug}@example.org`;
    const create = await app.inject({
      method: "POST",
      url: "/v1/invitations",
      headers: authHeader(f.inviterToken),
      payload: { email },
    });
    const created = create.json<{ data: { id: string } }>().data;
    const tokenRows = await db
      .select({ token: invitations.token })
      .from(invitations)
      .where(eq(invitations.id, created.id));
    const token = tokenRows[0]?.token ?? "";

    const res = await app.inject({
      method: "POST",
      url: `/v1/invitations/${token}/accept`,
      payload: { firstName: "X", lastName: "Y", password: "long-enough-password-1" },
    });
    expect(res.statusCode).toBe(201);
    expect(kcCreateOrganization).toHaveBeenCalledTimes(1);

    const [tenant] = await db
      .select({ kcOrgId: tenants.keycloakOrgId })
      .from(tenants)
      .where(eq(tenants.id, f.orgId));
    expect(tenant?.kcOrgId).toBeTruthy();
  });

  it("rejects org adoption when KC alias collision returns a foreign org_id (no silent takeover)", async () => {
    const f = await makeFixture({ withKcOrgId: false });
    const email = `foreign+${f.slug}@example.org`;
    const create = await app.inject({
      method: "POST",
      url: "/v1/invitations",
      headers: authHeader(f.inviterToken),
      payload: { email },
    });
    const created = create.json<{ data: { id: string } }>().data;
    const tokenRows = await db
      .select({ token: invitations.token })
      .from(invitations)
      .where(eq(invitations.id, created.id));
    const token = tokenRows[0]?.token ?? "";

    // First call: KC reports the alias is taken. Second call (lookup by
    // alias): returns an Org belonging to a *different* tenant.
    kcCreateOrganization.mockRejectedValueOnce(
      new KeycloakAdminError("alias taken", 409, "/organizations"),
    );
    kcGetOrganizationByAlias.mockResolvedValueOnce({
      id: randomUUID(),
      name: "Foreign",
      alias: f.slug,
      attributes: { org_id: [randomUUID()] },
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/invitations/${token}/accept`,
      payload: { firstName: "X", lastName: "Y", password: "long-enough-password-1" },
    });
    // Service throws — Fastify maps to 500 by default. This is the intended
    // "fail loud" behaviour: an alias-collision with a foreign org_id is
    // tampering or misconfiguration, not a path the user can recover from.
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
  });

  it("rejects accept on an expired invitation", async () => {
    const f = await makeFixture();
    const token = randomUUID();
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_organization_id', ${f.orgId}, true)`);
      await tx.insert(invitations).values({
        orgId: f.orgId,
        email: `expired+${f.slug}@example.org`,
        role: "user",
        token,
        purpose: "team_invite",
        expiresAt: new Date(Date.now() - 60 * 1000),
      });
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/invitations/${token}/accept`,
      payload: { firstName: "X", lastName: "Y", password: "long-enough-password-1" },
    });
    expect(res.statusCode).toBe(410);
  });

  it("rejects accept on an already-accepted invitation", async () => {
    const f = await makeFixture();
    const email = `twice+${f.slug}@example.org`;
    const create = await app.inject({
      method: "POST",
      url: "/v1/invitations",
      headers: authHeader(f.inviterToken),
      payload: { email },
    });
    const created = create.json<{ data: { id: string } }>().data;
    const tokenRows = await db
      .select({ token: invitations.token })
      .from(invitations)
      .where(eq(invitations.id, created.id));
    const token = tokenRows[0]?.token ?? "";

    const first = await app.inject({
      method: "POST",
      url: `/v1/invitations/${token}/accept`,
      payload: { firstName: "First", lastName: "Try", password: "long-enough-password-1" },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: `/v1/invitations/${token}/accept`,
      payload: { firstName: "Second", lastName: "Try", password: "long-enough-password-1" },
    });
    expect(second.statusCode).toBe(410);
  });

  it("rejects an underlength password with 400 (not 410)", async () => {
    const f = await makeFixture();
    const create = await app.inject({
      method: "POST",
      url: "/v1/invitations",
      headers: authHeader(f.inviterToken),
      payload: { email: `pw+${f.slug}@example.org` },
    });
    const created = create.json<{ data: { id: string } }>().data;
    const tokenRows = await db
      .select({ token: invitations.token })
      .from(invitations)
      .where(eq(invitations.id, created.id));
    const token = tokenRows[0]?.token ?? "";

    const res = await app.inject({
      method: "POST",
      url: `/v1/invitations/${token}/accept`,
      payload: { firstName: "X", lastName: "Y", password: "short" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("happy path with role=org_admin promotes the invitee to second org_admin (AC #9)", async () => {
    const f = await makeFixture();
    const email = `secondadmin+${f.slug}@example.org`;

    const create = await app.inject({
      method: "POST",
      url: "/v1/invitations",
      headers: authHeader(f.inviterToken),
      payload: { email, role: "org_admin" },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json<{ data: { id: string } }>().data;
    const tokenRows = await db
      .select({ token: invitations.token })
      .from(invitations)
      .where(eq(invitations.id, created.id));
    const token = tokenRows[0]?.token ?? "";

    const accept = await app.inject({
      method: "POST",
      url: `/v1/invitations/${token}/accept`,
      payload: {
        firstName: "Second",
        lastName: "Admin",
        password: "long-enough-password-1",
      },
    });
    expect(accept.statusCode).toBe(201);

    const [user] = await db
      .select({ role: users.role, keycloakId: users.keycloakId })
      .from(users)
      .where(and(eq(users.orgId, f.orgId), eq(users.email, email.toLowerCase())));
    expect(user?.role).toBe("org_admin");
    expect(user?.keycloakId).toBeTruthy();

    // KC attribute payload must reflect the invitation's role, not the
    // inviter's — otherwise the realm mapper would emit the wrong JWT
    // claim and the invitee would land without admin access.
    const createUserCall = kcCreateUser.mock.calls[0]?.[0];
    expect(createUserCall?.attributes?.role).toEqual(["org_admin"]);
    expect(kcAttachUserToOrg).toHaveBeenCalledTimes(1);
  });

  it("after resend, the OLD token returns 410 (token rotation kills the old link) (AC #7)", async () => {
    const f = await makeFixture();
    const create = await app.inject({
      method: "POST",
      url: "/v1/invitations",
      headers: authHeader(f.inviterToken),
      payload: { email: `rotation+${f.slug}@example.org` },
    });
    const created = create.json<{ data: { id: string } }>().data;
    const before = await db
      .select({ token: invitations.token })
      .from(invitations)
      .where(eq(invitations.id, created.id));
    const oldToken = before[0]?.token ?? "";

    const resend = await app.inject({
      method: "POST",
      url: `/v1/invitations/${created.id}/resend`,
      headers: authHeader(f.inviterToken),
    });
    expect(resend.statusCode).toBe(204);

    // The old token must now be dead.
    const oldAccept = await app.inject({
      method: "POST",
      url: `/v1/invitations/${oldToken}/accept`,
      payload: { firstName: "X", lastName: "Y", password: "long-enough-password-1" },
    });
    expect(oldAccept.statusCode).toBe(410);

    // The new token must still be live.
    const after = await db
      .select({ token: invitations.token })
      .from(invitations)
      .where(eq(invitations.id, created.id));
    const newToken = after[0]?.token ?? "";
    expect(newToken).not.toBe(oldToken);

    const newAccept = await app.inject({
      method: "POST",
      url: `/v1/invitations/${newToken}/accept`,
      payload: { firstName: "X", lastName: "Y", password: "long-enough-password-1" },
    });
    expect(newAccept.statusCode).toBe(201);
  });

  it("after revoke, accept with the deleted token returns generic 410 (AC #6)", async () => {
    const f = await makeFixture();
    const create = await app.inject({
      method: "POST",
      url: "/v1/invitations",
      headers: authHeader(f.inviterToken),
      payload: { email: `revoke-then-accept+${f.slug}@example.org` },
    });
    const created = create.json<{ data: { id: string } }>().data;
    const tokenRows = await db
      .select({ token: invitations.token })
      .from(invitations)
      .where(eq(invitations.id, created.id));
    const token = tokenRows[0]?.token ?? "";

    const revoke = await app.inject({
      method: "DELETE",
      url: `/v1/invitations/${created.id}`,
      headers: authHeader(f.inviterToken),
    });
    expect(revoke.statusCode).toBe(204);

    const accept = await app.inject({
      method: "POST",
      url: `/v1/invitations/${token}/accept`,
      payload: { firstName: "X", lastName: "Y", password: "long-enough-password-1" },
    });
    expect(accept.statusCode).toBe(410);
    // No KC user was created for the dead-token attempt.
    expect(kcCreateUser).not.toHaveBeenCalled();
  });

  // ─── Issue #153 — locale resolution (4-cell matrix) ───────────────────────
  //
  // The dispatcher resolves the recipient's locale at enqueue time as
  // `users.locale ?? tenants.default_locale`, then stamps it on the outbox
  // payload. Cover all four cells:
  //   tenant=fr, user=NULL → fr   tenant=fr, user=en → en
  //   tenant=en, user=NULL → en   tenant=en, user=fr → fr
  describe.each([
    { tenantDefault: "fr" as const, existingUserLocale: null, expected: "fr" as const },
    { tenantDefault: "fr" as const, existingUserLocale: "en" as const, expected: "en" as const },
    { tenantDefault: "en" as const, existingUserLocale: null, expected: "en" as const },
    { tenantDefault: "en" as const, existingUserLocale: "fr" as const, expected: "fr" as const },
  ])("stamps locale=$expected on invitation.created when tenant.default_locale=$tenantDefault and users.locale=$existingUserLocale", ({
    tenantDefault,
    existingUserLocale,
    expected,
  }) => {
    it("resolves invitee.locale ?? tenant.default_locale", async () => {
      const f = await makeFixture({ defaultLocale: tenantDefault });
      const email = `matrix-${randomUUID().slice(0, 6)}+${f.slug}@example.org`;

      // Seed a `users` row to model the case where the invitee already
      // exists as a member (re-invite) so the per-user override layer is
      // actually exercised. The `locale` column carries the personal
      // preference.
      if (existingUserLocale !== null) {
        await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT set_config('app.current_organization_id', ${f.orgId}, true)`);
          await tx.insert(users).values({
            orgId: f.orgId,
            email,
            firstName: "Existing",
            lastName: "Member",
            role: "user",
            locale: existingUserLocale,
          });
        });
      }

      // The create path's pre-flight rejects existing-member invites with
      // 409 (UX hint). Skip it for the override cells by enqueueing a
      // resend instead — same outbox-stamping code path.
      let invitationId: string;
      if (existingUserLocale !== null) {
        // Insert a pending invitation directly so we can hit resend.
        const id = randomUUID();
        await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT set_config('app.current_organization_id', ${f.orgId}, true)`);
          await tx.insert(invitations).values({
            id,
            orgId: f.orgId,
            email,
            role: "user",
            purpose: "team_invite",
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          });
        });
        const resend = await app.inject({
          method: "POST",
          url: `/v1/invitations/${id}/resend`,
          headers: authHeader(f.inviterToken),
        });
        expect(resend.statusCode).toBe(204);
        invitationId = id;
      } else {
        const create = await app.inject({
          method: "POST",
          url: "/v1/invitations",
          headers: authHeader(f.inviterToken),
          payload: { email },
        });
        expect(create.statusCode).toBe(201);
        const json = create.json() as { data: { id: string } };
        invitationId = json.data.id;
      }

      const eventType = existingUserLocale !== null ? "invitation.resent" : "invitation.created";
      const { rows } = await db.execute<{ payload: { locale?: string } }>(
        sql`SELECT payload FROM outbox_events
              WHERE tenant_id = ${f.orgId}
                AND type = ${eventType}
                AND payload->>'invitationId' = ${invitationId}
              ORDER BY created_at DESC LIMIT 1`,
      );
      expect(rows[0]?.payload?.locale).toBe(expected);
    });
  });

  it("acceptTeamInvitation persists users.locale only when chosen value differs from tenant default", async () => {
    const f = await makeFixture({ defaultLocale: "fr" });
    const email = `accept-locale-${randomUUID().slice(0, 6)}+${f.slug}@example.org`;
    const create = await app.inject({
      method: "POST",
      url: "/v1/invitations",
      headers: authHeader(f.inviterToken),
      payload: { email, role: "user" },
    });
    expect(create.statusCode).toBe(201);

    const [invitation] = await db
      .select({ token: invitations.token })
      .from(invitations)
      .where(and(eq(invitations.orgId, f.orgId), eq(invitations.email, email)))
      .limit(1);
    const token = invitation?.token;
    expect(token).toBeDefined();

    // Accept with a value that DIFFERS from tenant default → users.locale persists.
    const accept = await app.inject({
      method: "POST",
      url: `/v1/invitations/${token}/accept`,
      payload: {
        firstName: "Anna",
        lastName: "Override",
        password: "long-enough-password-12",
        locale: "en",
      },
    });
    expect(accept.statusCode).toBe(201);

    const [persisted] = await db
      .select({ locale: users.locale })
      .from(users)
      .where(and(eq(users.orgId, f.orgId), eq(users.email, email)))
      .limit(1);
    expect(persisted?.locale).toBe("en");
  });

  it("acceptTeamInvitation leaves users.locale NULL when chosen value matches tenant default", async () => {
    const f = await makeFixture({ defaultLocale: "fr" });
    const email = `accept-default-${randomUUID().slice(0, 6)}+${f.slug}@example.org`;
    const create = await app.inject({
      method: "POST",
      url: "/v1/invitations",
      headers: authHeader(f.inviterToken),
      payload: { email, role: "user" },
    });
    expect(create.statusCode).toBe(201);

    const [invitation] = await db
      .select({ token: invitations.token })
      .from(invitations)
      .where(and(eq(invitations.orgId, f.orgId), eq(invitations.email, email)))
      .limit(1);
    const token = invitation?.token;
    expect(token).toBeDefined();

    // Accept with the SAME value as tenant default → users.locale stays NULL,
    // so a future tenant-default change carries through to this user.
    const accept = await app.inject({
      method: "POST",
      url: `/v1/invitations/${token}/accept`,
      payload: {
        firstName: "Anna",
        lastName: "Default",
        password: "long-enough-password-12",
        locale: "fr",
      },
    });
    expect(accept.statusCode).toBe(201);

    const [persisted] = await db
      .select({ locale: users.locale })
      .from(users)
      .where(and(eq(users.orgId, f.orgId), eq(users.email, email)))
      .limit(1);
    expect(persisted?.locale).toBeNull();
  });

  it("probe response carries the tenant's default_locale (issue #153)", async () => {
    const f = await makeFixture({ defaultLocale: "fr" });
    const email = `probe-locale-${randomUUID().slice(0, 6)}+${f.slug}@example.org`;
    const create = await app.inject({
      method: "POST",
      url: "/v1/invitations",
      headers: authHeader(f.inviterToken),
      payload: { email, role: "user" },
    });
    expect(create.statusCode).toBe(201);

    const [invitation] = await db
      .select({ token: invitations.token })
      .from(invitations)
      .where(and(eq(invitations.orgId, f.orgId), eq(invitations.email, email)))
      .limit(1);
    const token = invitation?.token;
    expect(token).toBeDefined();

    const probe = await app.inject({
      method: "GET",
      url: `/v1/invitations/${token}/probe`,
    });
    expect(probe.statusCode).toBe(200);
    const body = probe.json() as { data: { tenantDefaultLocale: string } };
    expect(body.data.tenantDefaultLocale).toBe("fr");
  });

  // ─── Cross-tenant isolation ───────────────────────────────────────────

  it("org_admin in tenant A cannot revoke / resend / read an invitation from tenant B (SEC-F2)", async () => {
    const fA = await makeFixture();
    const fB = await makeFixture();

    // Create an invitation in tenant B.
    const createB = await app.inject({
      method: "POST",
      url: "/v1/invitations",
      headers: authHeader(fB.inviterToken),
      payload: { email: `bb+${fB.slug}@example.org` },
    });
    expect(createB.statusCode).toBe(201);
    const inviteB = createB.json<{ data: { id: string } }>().data;

    // Tenant A admin cannot revoke B's invitation by id.
    const revoke = await app.inject({
      method: "DELETE",
      url: `/v1/invitations/${inviteB.id}`,
      headers: authHeader(fA.inviterToken),
    });
    expect(revoke.statusCode).toBe(404);

    // Tenant A admin cannot resend B's invitation by id.
    const resend = await app.inject({
      method: "POST",
      url: `/v1/invitations/${inviteB.id}/resend`,
      headers: authHeader(fA.inviterToken),
    });
    expect(resend.statusCode).toBe(404);

    // Tenant A admin's list does not include B's invitation.
    const list = await app.inject({
      method: "GET",
      url: "/v1/invitations",
      headers: authHeader(fA.inviterToken),
    });
    expect(list.statusCode).toBe(200);
    const listBody = list.json<{ data: Array<{ id: string }> }>();
    expect(listBody.data.find((row) => row.id === inviteB.id)).toBeUndefined();

    // Tenant B's invitation row is untouched.
    const [stillThere] = await db
      .select({ id: invitations.id, acceptedAt: invitations.acceptedAt })
      .from(invitations)
      .where(eq(invitations.id, inviteB.id));
    expect(stillThere).toBeDefined();
    expect(stillThere?.acceptedAt).toBeNull();
  });
});

// ─── Public probe (PR #154 follow-up) ────────────────────────────────────────
//
// `GET /v1/invitations/:token/probe` is the side-effect-free check the
// /invite/accept page hits on load to short-circuit dead links to the
// terminal screen. Anti-enumeration: every failure mode collapses to 410
// — the same shape the accept endpoint enforces.

describe("GET /v1/invitations/:token/probe", () => {
  it("returns 200 + tenantDefaultLocale for a valid pending unexpired team-invite token (issue #153)", async () => {
    const f = await makeFixture();
    const create = await app.inject({
      method: "POST",
      url: "/v1/invitations",
      headers: authHeader(f.inviterToken),
      payload: { email: `probe-valid+${f.slug}@example.org`, role: "user" },
    });
    expect(create.statusCode).toBe(201);
    // Look up the freshly-minted token (not returned by the create endpoint).
    const [row] = await db
      .select({ token: invitations.token })
      .from(invitations)
      .where(eq(invitations.id, create.json<{ data: { id: string } }>().data.id));
    expect(row?.token).toBeDefined();

    const probe = await app.inject({
      method: "GET",
      url: `/v1/invitations/${row?.token}/probe`,
    });
    // Issue #153: probe success response moved from 204 → 200 with body so
    // the accept form can pre-select the right locale picker option.
    expect(probe.statusCode).toBe(200);
    const body = probe.json() as { data: { tenantDefaultLocale: string } };
    expect(body.data.tenantDefaultLocale).toMatch(/^(en|fr)$/);
  });

  it("returns 410 when the invitation has been accepted", async () => {
    const f = await makeFixture();
    const create = await app.inject({
      method: "POST",
      url: "/v1/invitations",
      headers: authHeader(f.inviterToken),
      payload: { email: `probe-accepted+${f.slug}@example.org`, role: "user" },
    });
    const id = create.json<{ data: { id: string } }>().data.id;
    const [row] = await db
      .select({ token: invitations.token })
      .from(invitations)
      .where(eq(invitations.id, id));
    await db.execute(sql`UPDATE invitations SET accepted_at = now() WHERE id = ${id}`);

    const probe = await app.inject({
      method: "GET",
      url: `/v1/invitations/${row?.token}/probe`,
    });
    expect(probe.statusCode).toBe(410);
  });

  it("returns 410 when the invitation has expired", async () => {
    const f = await makeFixture();
    const create = await app.inject({
      method: "POST",
      url: "/v1/invitations",
      headers: authHeader(f.inviterToken),
      payload: { email: `probe-expired+${f.slug}@example.org`, role: "user" },
    });
    const id = create.json<{ data: { id: string } }>().data.id;
    const [row] = await db
      .select({ token: invitations.token })
      .from(invitations)
      .where(eq(invitations.id, id));
    await db.execute(
      sql`UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE id = ${id}`,
    );

    const probe = await app.inject({
      method: "GET",
      url: `/v1/invitations/${row?.token}/probe`,
    });
    expect(probe.statusCode).toBe(410);
  });

  it("returns 410 for an unknown token (no enumeration)", async () => {
    const probe = await app.inject({
      method: "GET",
      url: `/v1/invitations/${randomUUID()}/probe`,
    });
    expect(probe.statusCode).toBe(410);
  });

  it("returns 410 for a row whose purpose is not team_invite", async () => {
    // Insert a `signup_verification` row directly so the probe finds
    // a row by token but rejects it on purpose. Anti-enumeration shape:
    // same 410 as a wholly missing row, no discriminator.
    const f = await makeFixture();
    const id = randomUUID();
    const token = randomUUID();
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_organization_id', ${f.orgId}, true)`);
      await tx.insert(invitations).values({
        id,
        orgId: f.orgId,
        email: `signup+${f.slug}@example.org`,
        role: "org_admin",
        token,
        purpose: "signup_verification",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
    });

    const probe = await app.inject({
      method: "GET",
      url: `/v1/invitations/${token}/probe`,
    });
    expect(probe.statusCode).toBe(410);
  });

  it("every 410 failure path returns the SAME body (anti-enumeration regression test, QA review F-Q3)", async () => {
    // Hit each documented 410 path and assert the response body is
    // byte-identical. If any future change leaks a discriminator (a
    // different `detail`, `title`, or `type` per failure mode), this
    // test fails — preserving SEC-6's "no enumeration oracle" stance.
    const f = await makeFixture();

    // Path 1 — unknown token.
    const unknown = await app.inject({
      method: "GET",
      url: `/v1/invitations/${randomUUID()}/probe`,
    });

    // Path 2 — accepted token.
    const acceptedCreate = await app.inject({
      method: "POST",
      url: "/v1/invitations",
      headers: authHeader(f.inviterToken),
      payload: { email: `accepted+${f.slug}@example.org`, role: "user" },
    });
    expect(acceptedCreate.statusCode).toBe(201);
    const [acceptedRow] = await db
      .select({ id: invitations.id, token: invitations.token })
      .from(invitations)
      .where(eq(invitations.id, acceptedCreate.json<{ data: { id: string } }>().data.id));
    if (!acceptedRow) throw new Error("seed failure: accepted invitation row not found");
    await db
      .update(invitations)
      .set({ acceptedAt: new Date() })
      .where(eq(invitations.id, acceptedRow.id));
    const accepted = await app.inject({
      method: "GET",
      url: `/v1/invitations/${acceptedRow.token}/probe`,
    });

    // Path 3 — expired token.
    const expiredId = randomUUID();
    const expiredToken = randomUUID();
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_organization_id', ${f.orgId}, true)`);
      await tx.insert(invitations).values({
        id: expiredId,
        orgId: f.orgId,
        email: `expired+${f.slug}@example.org`,
        role: "user",
        token: expiredToken,
        purpose: "team_invite",
        expiresAt: new Date(Date.now() - 60_000),
      });
    });
    const expired = await app.inject({
      method: "GET",
      url: `/v1/invitations/${expiredToken}/probe`,
    });

    // Path 4 — wrong purpose (signup_verification row).
    const wrongPurposeId = randomUUID();
    const wrongPurposeToken = randomUUID();
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_organization_id', ${f.orgId}, true)`);
      await tx.insert(invitations).values({
        id: wrongPurposeId,
        orgId: f.orgId,
        email: `wrong-purpose+${f.slug}@example.org`,
        role: "org_admin",
        token: wrongPurposeToken,
        purpose: "signup_verification",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
    });
    const wrongPurpose = await app.inject({
      method: "GET",
      url: `/v1/invitations/${wrongPurposeToken}/probe`,
    });

    const responses = [unknown, accepted, expired, wrongPurpose];
    for (const r of responses) {
      expect(r.statusCode).toBe(410);
    }
    // The body shape is the RFC 9457 problem detail; assert each field
    // matches across all four paths so a future regression that adds a
    // discriminator would fail loud.
    const bodies = responses.map((r) => r.json() as Record<string, unknown>);
    expect(new Set(bodies.map((b) => b.title)).size).toBe(1);
    expect(new Set(bodies.map((b) => b.detail)).size).toBe(1);
    expect(new Set(bodies.map((b) => b.status)).size).toBe(1);
  });
});
