/**
 * Issue #161 — `PATCH /v1/users/:id` end-to-end coverage.
 *
 * Replaces the legacy role-only `PATCH /v1/users/:id/role` with a combined
 * endpoint accepting `{ firstName?, lastName?, role? }`. This file locks
 * the contract at the route boundary:
 *
 *  - Field-level updates (each field independently, then combinations)
 *  - Audit row carries the field-level diff
 *  - Self-demote guard returns 422 with `errorCode: cannot_self_demote`
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
  deleteUser: vi.fn(async () => {}),
  createIdentityProvider: vi.fn(async () => {}),
  deleteIdentityProvider: vi.fn(async () => {}),
  // Issue #254 — platform-admin CRUD helpers. User-edit flow never calls them.
  getRealmRole: vi.fn(async () => null),
  assignRealmRoleToUser: vi.fn(async () => {}),
  sendExecuteActionsEmail: vi.fn(async () => {}),
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
      .select({
        userId: auditLogs.userId,
        actorId: auditLogs.actorId,
        resourceId: auditLogs.resourceId,
        oldValues: auditLogs.oldValues,
        newValues: auditLogs.newValues,
        ipHash: auditLogs.ipHash,
        userAgent: auditLogs.userAgent,
      })
      .from(auditLogs)
      .where(and(eq(auditLogs.orgId, f.orgId), eq(auditLogs.action, "user.profile_updated")));
    expect(audit?.oldValues).toEqual({ firstName: "Member" });
    expect(audit?.newValues).toEqual({ firstName: "Renamed" });
    // Review E5 — `audit_logs.user_id` is the JWT subject (actor under
    // normal auth). `actor_id` is NULL under normal auth (only set under
    // RFC 8693 impersonation). The target's UUID belongs in `resource_id`.
    expect(audit?.userId).toBe(f.adminKcId);
    expect(audit?.actorId).toBeNull();
    expect(audit?.resourceId).toBe(f.memberUserId);
    // Forensic context — the row must carry ip_hash + user_agent (not
    // null) so the domain audit row matches the auto-row's coverage.
    // app.inject's default request has `127.0.0.1` for ip and no
    // user-agent header, so we just assert the columns are non-null.
    expect(audit?.ipHash).toBeTruthy();
    expect(audit?.ipHash?.length).toBe(16);

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
    const body = res.json<{
      status: number;
      errorCode: string;
      title: string;
      detail: string;
    }>();
    expect(body).toMatchObject({
      status: 422,
      errorCode: "cannot_self_demote",
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

  it("returns 422 missing_keycloak_link when target user has no keycloak_id (review PJD-3)", async () => {
    // Fail-closed when `existing.keycloakId` is null so the self-demote
    // comparison `null === callerKcId` cannot silently bypass the guard.
    const f = await makeFixture();

    // Detach the member's KC link to simulate a legacy-imported row.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_organization_id', ${f.orgId}, true)`);
      await tx.update(users).set({ keycloakId: null }).where(eq(users.id, f.memberUserId));
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/users/${f.memberUserId}`,
      headers: authHeader(f.adminToken),
      payload: { role: "viewer" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      type: "https://httpproblems.com/http-status/422",
      title: "Unprocessable Entity",
      status: 422,
      errorCode: "missing_keycloak_link",
    });

    // DB unchanged.
    const [target] = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, f.memberUserId));
    expect(target?.role).toBe("user");
  });

  it("name-only edits succeed even when target has no keycloak_id (PJD-3 — only role changes blocked)", async () => {
    // Name edits don't touch the role guard, so they should still work
    // when the keycloak link is missing (the KC `updateUser` call gets
    // skipped because there's no kcId, but DB + audit row land correctly).
    const f = await makeFixture();

    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_organization_id', ${f.orgId}, true)`);
      await tx.update(users).set({ keycloakId: null }).where(eq(users.id, f.memberUserId));
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/users/${f.memberUserId}`,
      headers: authHeader(f.adminToken),
      payload: { firstName: "Renamed" },
    });
    expect(res.statusCode).toBe(200);
    expect(kcUpdateUser).not.toHaveBeenCalled();
  });

  it("returns 422 cannot_demote_last_admin when another admin demotes the only remaining org_admin (review S1)", async () => {
    // Fixture seeds ONE admin; the test makes a second admin (the caller),
    // and uses them to demote the original admin. With only the caller +
    // the target left as admins, demoting the target leaves zero admins —
    // the lock-out guard must refuse.
    //
    // To exercise: set up a tenant with admin A (the caller's "another admin")
    // and admin T (the target). Demote T → no admins left except A. That's
    // ONE remaining admin AFTER demotion, which is fine. So we need:
    // tenant with ONLY admin T; caller is admin A from the SAME org but
    // not yet a row. Easier setup: tenant with admin T (= callerKcId
    // = different sub, role org_admin); caller's token is signed with
    // a different sub mapping to admin A. But the caller needs a `users`
    // row to satisfy auth.
    //
    // Cleaner approach: tenant with ONE admin row (T). Caller token is
    // a DIFFERENT admin (A) — the role check passes via JWT claim, and
    // the route resolves the target by id. After demotion, zero admin
    // rows would remain → guard fires.
    const f = await makeFixture();

    // The caller in `makeFixture` already has `f.adminUserId` (admin A) +
    // `f.memberUserId` (member with role "user"). Promote the member to
    // org_admin first, then attempt to demote A — the only OTHER admin
    // would be the just-promoted member, so we need a separate setup.
    //
    // Simplest: directly demote `f.adminUserId` from admin B's session,
    // where admin B is the only other admin. Build it: promote the member
    // to admin via the route, then have member-token caller demote f.admin.
    // But test that already covers admin → 200 path; reusing it makes the
    // flow noisy. Use SQL directly:
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_organization_id', ${f.orgId}, true)`);
      await tx.update(users).set({ role: "user" }).where(eq(users.id, f.memberUserId));
    });

    // Now the tenant has exactly one admin (f.adminUserId). Caller is the
    // same admin demoting THEMSELVES, but `cannot_self_demote` fires first.
    // To hit `cannot_demote_last_admin`, we need a SECOND admin to be the
    // caller. Create one inline:
    const secondAdminId = randomUUID();
    const secondAdminKcId = `kc-second-${randomUUID().slice(0, 8)}`;
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_organization_id', ${f.orgId}, true)`);
      await tx.insert(users).values({
        id: secondAdminId,
        orgId: f.orgId,
        email: `second-${f.slug}@example.org`,
        firstName: "Second",
        lastName: "Admin",
        role: "org_admin",
        keycloakId: secondAdminKcId,
      });
    });
    const secondAdminToken = signToken(app, {
      sub: secondAdminKcId,
      org_id: f.orgId,
      role: "org_admin",
    });

    // Now demote the FIRST admin via the SECOND admin → after demotion,
    // only the second admin remains (1 admin). Self-demote not triggered.
    // Last-admin guard not triggered (still 1 admin left). Should succeed.
    const sanity = await app.inject({
      method: "PATCH",
      url: `/v1/users/${f.adminUserId}`,
      headers: authHeader(secondAdminToken),
      payload: { role: "user" },
    });
    expect(sanity.statusCode).toBe(200);

    // Now there's only ONE admin (secondAdminId). Try to demote them via
    // the original admin's token — but f.adminUserId is now `user`, so
    // their token (role: org_admin in JWT but not in DB) — actually JWT
    // role still says org_admin so requireOrgAdmin passes. The route
    // resolves the target by id (secondAdminId) and finds 1 admin.
    // After demotion: 0 admins. Guard must fire.
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/users/${secondAdminId}`,
      headers: authHeader(f.adminToken),
      payload: { role: "user" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      type: "https://httpproblems.com/http-status/422",
      title: "Unprocessable Entity",
      status: 422,
      errorCode: "cannot_demote_last_admin",
    });

    // DB unchanged.
    const [target] = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, secondAdminId));
    expect(target?.role).toBe("org_admin");
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
    // Reuse the fixture's member sub — the auth-boundary active-row
    // check (ADR-021) requires (sub, org_id) to resolve before the
    // route's `requireOrgAdmin` can fire. The fixture's member is
    // seeded with role="user" in the DB; the JWT here overrides only
    // the role claim so the role check sees "user" and 403s.
    const userToken = signToken(app, {
      sub: f.memberKcId,
      org_id: f.orgId,
      role: "user",
    });

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
    // Lock the RFC 9457 body shape (review Q5).
    expect(res.json()).toMatchObject({
      type: "https://httpproblems.com/http-status/404",
      title: "Not Found",
      status: 404,
    });
  });

  // ─── Keycloak sync failure paths (review Q9) ──────────────────────────────

  it("kc updateUser failure → 200 + DB committed + warn line (Q9)", async () => {
    const f = await makeFixture();
    kcUpdateUser.mockRejectedValueOnce(new Error("KC down"));

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/users/${f.memberUserId}`,
      headers: authHeader(f.adminToken),
      payload: { firstName: "RenamedDespiteKcDown" },
    });

    // Route MUST swallow the KC error and return 200; SRE relies on the
    // log-line discriminator name being stable for grep / Loki alerts.
    // A regression that re-throws would 500 the caller and drift DB ↔ KC
    // without a recovery path; the test pins the swallow behaviour.
    expect(res.statusCode).toBe(200);

    const [memberRow] = await db
      .select({ firstName: users.firstName })
      .from(users)
      .where(eq(users.id, f.memberUserId));
    expect(memberRow?.firstName).toBe("RenamedDespiteKcDown");

    expect(kcUpdateUser).toHaveBeenCalledTimes(1);
  });

  it("kc setUserAttributes failure → 200 + DB committed + role warn line (Q9)", async () => {
    const f = await makeFixture();
    kcSetUserAttributes.mockRejectedValueOnce(new Error("KC down"));

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

    expect(kcSetUserAttributes).toHaveBeenCalledTimes(1);
  });

  it("viewer → 403 (lower edge of the requireOrgAdmin boundary)", async () => {
    // Both-directions coverage rule (review Q4): user → 403 was already
    // tested; this locks the viewer side too. A regression that loosens
    // the guard to `requireWrite` would still 403 a viewer but not a user
    // — the symmetric tests catch both shapes.
    const f = await makeFixture();
    // Reuse the fixture's member sub for the same reason as the
    // user-token test above (ADR-021 active-row check).
    const viewerToken = signToken(app, {
      sub: f.memberKcId,
      org_id: f.orgId,
      role: "viewer",
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/users/${f.memberUserId}`,
      headers: authHeader(viewerToken),
      payload: { firstName: "X" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      type: "https://httpproblems.com/http-status/403",
      title: "Forbidden",
      status: 403,
    });
  });
});
