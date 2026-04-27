/**
 * Issue #161 — `PATCH /v1/users/:id` end-to-end coverage.
 *
 * Replaces the legacy role-only `PATCH /v1/users/:id/role` with a combined
 * endpoint accepting `{ firstName?, lastName?, role? }`. This file locks
 * the contract at the route boundary:
 *
 *  - Field-level updates (each field independently, then combinations)
 *  - Audit row carries the field-level diff
 *  - Self-demote guard returns 422 with `code: cannot_self_demote`
 *  - Keycloak sync calls fire only when the corresponding field is in the body
 *  - RBAC: non-admin → 403 (positive direction = admin → 200 covered below)
 *  - 404 when the user doesn't exist in the caller's tenant
 *
 * The Keycloak admin client is replaced with a vi.fn() stub so we can assert
 * call counts without exercising a real KC instance — same pattern as
 * `team-invitations.test.ts`.
 */

import { randomUUID } from "node:crypto";
import { auditLogs, tenants, users } from "@givernance/shared/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../lib/db.js";
import {
  _resetKeycloakAdminSingleton,
  _setKeycloakAdminSingleton,
  type KeycloakAdminClient,
} from "../../lib/keycloak-admin.js";
import { createServer } from "../../server.js";
import { authHeader, signToken } from "../helpers/auth.js";

let app: FastifyInstance;

const kcUpdateUser = vi.fn<KeycloakAdminClient["updateUser"]>(async () => {});
const kcSetUserAttributes = vi.fn<KeycloakAdminClient["setUserAttributes"]>(async () => {});

const fakeKeycloakAdmin: KeycloakAdminClient = {
  createOrganization: vi.fn(),
  getOrganization: vi.fn(async () => null),
  getOrganizationByAlias: vi.fn(async () => null),
  deleteOrganization: vi.fn(async () => {}),
  addOrgDomain: vi.fn(async () => {}),
  attachUserToOrg: vi.fn(async () => {}),
  sendInvitation: vi.fn(async () => {}),
  bindIdpToOrganization: vi.fn(async () => {}),
  createUser: vi.fn(),
  getUserByEmail: vi.fn(async () => null),
  resetUserPassword: vi.fn(async () => {}),
  setUserAttributes: kcSetUserAttributes,
  updateUser: kcUpdateUser,
  createIdentityProvider: vi.fn(async () => {}),
  deleteIdentityProvider: vi.fn(async () => {}),
  _circuitState: () => "closed",
};

interface Fixture {
  orgId: string;
  slug: string;
  adminUserId: string;
  adminKcId: string;
  adminToken: string;
  memberUserId: string;
  memberKcId: string;
}

const fixtureSlugs = new Set<string>();

async function makeFixture(): Promise<Fixture> {
  const orgId = randomUUID();
  const adminUserId = randomUUID();
  const memberUserId = randomUUID();
  const adminKcId = `kc-admin-${randomUUID().slice(0, 8)}`;
  const memberKcId = `kc-member-${randomUUID().slice(0, 8)}`;
  const slug = `user-edit-${randomUUID().slice(0, 8)}`;
  fixtureSlugs.add(slug);

  await db.execute(
    sql`INSERT INTO tenants (id, name, slug)
        VALUES (${orgId}, ${`User Edit Test ${slug}`}, ${slug})`,
  );

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_organization_id', ${orgId}, true)`);
    await tx.insert(users).values([
      {
        id: adminUserId,
        orgId,
        email: `admin-${slug}@example.org`,
        firstName: "Admin",
        lastName: "Owner",
        role: "org_admin",
        keycloakId: adminKcId,
      },
      {
        id: memberUserId,
        orgId,
        email: `member-${slug}@example.org`,
        firstName: "Member",
        lastName: "Doe",
        role: "user",
        keycloakId: memberKcId,
      },
    ]);
  });

  const adminToken = signToken(app, {
    sub: adminKcId,
    org_id: orgId,
    email: `admin-${slug}@example.org`,
    role: "org_admin",
  });

  return { orgId, slug, adminUserId, adminKcId, adminToken, memberUserId, memberKcId };
}

beforeAll(async () => {
  _setKeycloakAdminSingleton(fakeKeycloakAdmin);
  app = await createServer();
  await app.ready();
});

beforeEach(() => {
  kcUpdateUser.mockClear();
  kcSetUserAttributes.mockClear();
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
      // for cleanup (matches signup.test.ts / team-invitations.test.ts).
      await tx.execute(sql`SET LOCAL session_replication_role = 'replica'`);
      await tx.delete(auditLogs).where(inArray(auditLogs.orgId, ids));
      await tx.delete(users).where(inArray(users.orgId, ids));
      await tx.delete(tenants).where(inArray(tenants.id, ids));
    });
  }
  fixtureSlugs.clear();
});

// ─── Field-level updates ─────────────────────────────────────────────────────

describe("PATCH /v1/users/:id (issue #161)", () => {
  it("updates firstName only — DB row + audit diff + KC updateUser, no role attribute call", async () => {
    const f = await makeFixture();

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/users/${f.memberUserId}`,
      headers: authHeader(f.adminToken),
      payload: { firstName: "Renamed" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { firstName: string } }>().data.firstName).toBe("Renamed");

    const [memberRow] = await db
      .select({ firstName: users.firstName, lastName: users.lastName, role: users.role })
      .from(users)
      .where(eq(users.id, f.memberUserId));
    expect(memberRow).toMatchObject({ firstName: "Renamed", lastName: "Doe", role: "user" });

    const [audit] = await db
      .select({ oldValues: auditLogs.oldValues, newValues: auditLogs.newValues })
      .from(auditLogs)
      .where(and(eq(auditLogs.orgId, f.orgId), eq(auditLogs.action, "user.profile_updated")));
    expect(audit?.oldValues).toEqual({ firstName: "Member" });
    expect(audit?.newValues).toEqual({ firstName: "Renamed" });

    expect(kcUpdateUser).toHaveBeenCalledWith(f.memberKcId, {
      firstName: "Renamed",
      lastName: undefined,
    });
    expect(kcSetUserAttributes).not.toHaveBeenCalled();
  });

  it("updates role only — DB row + KC setUserAttributes, no updateUser call", async () => {
    const f = await makeFixture();

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/users/${f.memberUserId}`,
      headers: authHeader(f.adminToken),
      payload: { role: "viewer" },
    });
    expect(res.statusCode).toBe(200);

    const [memberRow] = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, f.memberUserId));
    expect(memberRow?.role).toBe("viewer");

    expect(kcUpdateUser).not.toHaveBeenCalled();
    expect(kcSetUserAttributes).toHaveBeenCalledWith(f.memberKcId, { role: ["viewer"] });
  });

  it("updates firstName + lastName + role together — single audit row with full diff", async () => {
    const f = await makeFixture();

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/users/${f.memberUserId}`,
      headers: authHeader(f.adminToken),
      payload: { firstName: "Ada", lastName: "Lovelace", role: "org_admin" },
    });
    expect(res.statusCode).toBe(200);

    const [audit] = await db
      .select({ oldValues: auditLogs.oldValues, newValues: auditLogs.newValues })
      .from(auditLogs)
      .where(and(eq(auditLogs.orgId, f.orgId), eq(auditLogs.action, "user.profile_updated")));
    expect(audit?.newValues).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
      role: "org_admin",
    });
  });

  // ─── Self-demote guard ──────────────────────────────────────────────────────

  it("returns 422 cannot_self_demote when an org_admin demotes their own row below org_admin", async () => {
    const f = await makeFixture();

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/users/${f.adminUserId}`,
      headers: authHeader(f.adminToken),
      payload: { role: "user" },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json<{ status: number; code: string; title: string; detail: string }>();
    expect(body).toMatchObject({
      status: 422,
      code: "cannot_self_demote",
      title: "Unprocessable Entity",
    });

    // DB unchanged — guard fires INSIDE the transaction so the row never gets touched.
    const [me] = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, f.adminUserId));
    expect(me?.role).toBe("org_admin");

    expect(kcSetUserAttributes).not.toHaveBeenCalled();
  });

  it("allows an org_admin to edit their OWN name (self-edit lock is role-only)", async () => {
    const f = await makeFixture();

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/users/${f.adminUserId}`,
      headers: authHeader(f.adminToken),
      payload: { firstName: "Renamed-Admin" },
    });
    expect(res.statusCode).toBe(200);
    expect(kcUpdateUser).toHaveBeenCalledWith(f.adminKcId, {
      firstName: "Renamed-Admin",
      lastName: undefined,
    });
  });

  // ─── Validation + RBAC + 404 ───────────────────────────────────────────────

  it("rejects empty body (minProperties: 1) with 400", async () => {
    const f = await makeFixture();

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/users/${f.memberUserId}`,
      headers: authHeader(f.adminToken),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("non-admin (user role) → 403", async () => {
    const f = await makeFixture();
    const userToken = signToken(app, { org_id: f.orgId, role: "user" });

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/users/${f.memberUserId}`,
      headers: authHeader(userToken),
      payload: { firstName: "X" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      type: "https://httpproblems.com/http-status/403",
      title: "Forbidden",
      status: 403,
    });
  });

  it("returns 404 for a non-existent user id within the caller's tenant", async () => {
    const f = await makeFixture();
    const ghostId = randomUUID();

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/users/${ghostId}`,
      headers: authHeader(f.adminToken),
      payload: { firstName: "Ghost" },
    });
    expect(res.statusCode).toBe(404);
  });
});
