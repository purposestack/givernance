/**
 * Issue #254 — platform-admin CRUD API.
 *
 * Hits a real Postgres + Redis (per `tests/setup.ts`) and a stubbed
 * Keycloak admin client. Coverage:
 *   - RBAC anti-disclosure (non-super-admins get 404 on every endpoint)
 *   - Identity invariant (email belonging to a tenant `users` row → 409)
 *   - Self-removal forbidden (operator's own row → 400)
 *   - Last-admin guard (count == 1 → 400)
 *   - Audit rows written on every mutation
 *   - Keycloak side-effects: createUser → assign super_admin role →
 *     attach to platform Org → sendExecuteActionsEmail
 *   - Soft-delete propagates: KC deleteUser called + user blocklisted
 *   - RFC 9457 body shape locked on at least one error path
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db, systemDb } from "../../lib/db.js";
import { _setKeycloakAdminSingleton, type KeycloakAdminClient } from "../../lib/keycloak-admin.js";
import { redis } from "../../lib/redis.js";
import { createServer } from "../../server.js";
import { authHeader, signToken } from "../helpers/auth.js";

const PLATFORM_TENANT_ID = "00000000-0000-0000-0000-0000000000a1";
const SUPER_ADMIN_KEYCLOAK_ID = "00000000-0000-0000-0000-0000000000ad";
const SUPER_ADMIN_PLATFORM_ROW_ID = "00000000-0000-0000-0000-000000abcd01";

let app: FastifyInstance;

// ─── KC stub ────────────────────────────────────────────────────────────────

// IDs returned by the KC stub MUST be UUID-format strings — the
// `audit_logs` response schema constrains `user_id` to UUID. Some tests
// sign tokens with `sub: <returned-id>` to exercise distinct super-admin
// operators; a non-UUID would surface only when a *later* unrelated test
// asks `/v1/audit` to serialize and trips fast-json-stringify.
const kcCreateUser = vi.fn<KeycloakAdminClient["createUser"]>(async () => ({
  id: randomUUID(),
}));
const kcGetRealmRole = vi.fn<KeycloakAdminClient["getRealmRole"]>(async () => ({
  id: "kc-role-id",
  name: "super_admin",
}));
const kcGetOrganizationByAlias = vi.fn<KeycloakAdminClient["getOrganizationByAlias"]>(async () => ({
  id: "kc-platform-org-id",
  name: "Givernance Platform",
  alias: "platform",
}));
const kcAssignRealmRole = vi.fn<KeycloakAdminClient["assignRealmRoleToUser"]>(async () => {});
const kcAttachUserToOrg = vi.fn<KeycloakAdminClient["attachUserToOrg"]>(async () => {});
const kcSendExecuteActions = vi.fn<KeycloakAdminClient["sendExecuteActionsEmail"]>(async () => {});
const kcUpdateUser = vi.fn<KeycloakAdminClient["updateUser"]>(async () => {});
const kcDeleteUser = vi.fn<KeycloakAdminClient["deleteUser"]>(async () => {});

const fakeKeycloakAdmin: KeycloakAdminClient = {
  createOrganization: vi.fn(),
  getOrganization: vi.fn(async () => null),
  getOrganizationByAlias: kcGetOrganizationByAlias,
  deleteOrganization: vi.fn(async () => {}),
  addOrgDomain: vi.fn(async () => {}),
  attachUserToOrg: kcAttachUserToOrg,
  sendInvitation: vi.fn(async () => {}),
  bindIdpToOrganization: vi.fn(async () => {}),
  createUser: kcCreateUser,
  getUserByEmail: vi.fn(async () => null),
  resetUserPassword: vi.fn(async () => {}),
  setUserAttributes: vi.fn(async () => {}),
  updateUser: kcUpdateUser,
  deleteUser: kcDeleteUser,
  createIdentityProvider: vi.fn(async () => {}),
  deleteIdentityProvider: vi.fn(async () => {}),
  getRealmRole: kcGetRealmRole,
  assignRealmRoleToUser: kcAssignRealmRole,
  sendExecuteActionsEmail: kcSendExecuteActions,
  _circuitState: () => "closed",
};

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  _setKeycloakAdminSingleton(fakeKeycloakAdmin);
  // Sentinel platform tenant is seeded centrally by `ensureTestTenants`
  // in `tests/setup.ts` (data-architect minor #7). Migration 0034 also
  // inserts it idempotently for dev/prod.
  void PLATFORM_TENANT_ID;
});

afterAll(async () => {
  await app.close();
});

afterEach(async () => {
  // Reset KC stub call counts so each test asserts in isolation.
  vi.clearAllMocks();

  // Drop platform_admins rows other than the seeded operator so each test
  // starts with COUNT(*) = 1. We can't truncate audit_logs (the table is
  // append-only by trigger); audit rows accumulate across tests but every
  // assertion filters by `resource_id`, which is unique per test.
  await db.execute(sql`
    DELETE FROM platform_admins WHERE id <> ${SUPER_ADMIN_PLATFORM_ROW_ID}
  `);
  // Restore the seeded operator to its canonical active shape — the
  // soft-delete tests null its `keycloak_id` and set `deleted_at`.
  // The `email` column is included in the ON CONFLICT clause because
  // `impersonation.test.ts` inserts the same id under a different
  // email (`operator-super-admin@example.org`); without an email reset
  // the "super_admin sees the list with at least the seeded operator"
  // assertion below flakes when this file runs after impersonation.test
  // in the shared `givernance_test` DB. (Issue #255 fix.)
  await db.execute(sql`
    INSERT INTO platform_admins (id, keycloak_id, email, first_name, last_name)
    VALUES (${SUPER_ADMIN_PLATFORM_ROW_ID}, ${SUPER_ADMIN_KEYCLOAK_ID}, 'super@example.org', 'Super', 'Admin')
    ON CONFLICT (id) DO UPDATE SET deleted_at = NULL, keycloak_id = ${SUPER_ADMIN_KEYCLOAK_ID}, email = 'super@example.org', first_name = 'Super', last_name = 'Admin'
  `);

  // Wipe any user-blocklist Redis keys the soft-delete tests wrote so
  // subsequent tests aren't surprised when their actor's sub bounces.
  const keys = await redis.keys("auth:user-blocklist:*");
  if (keys.length) await redis.del(...keys);
});

function superAdminToken() {
  return signToken(app, {
    sub: SUPER_ADMIN_KEYCLOAK_ID,
    realm_access: { roles: ["super_admin"] },
    role: undefined,
  });
}

// ─── RBAC ───────────────────────────────────────────────────────────────────

describe("RBAC anti-disclosure", () => {
  it("non-super_admin gets 404 on list (no role probing)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/platform-admins",
      headers: authHeader(signToken(app)),
    });
    expect(res.statusCode).toBe(404);
  });

  it("non-super_admin gets 404 on create", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/platform-admins",
      headers: authHeader(signToken(app)),
      payload: { email: "x@example.org", firstName: "X", lastName: "Y" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("super_admin sees the list with at least the seeded operator", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/platform-admins",
      headers: authHeader(superAdminToken()),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ email: string }>; meta: { total: number } };
    expect(body.meta.total).toBeGreaterThanOrEqual(1);
    expect(body.data.some((r) => r.email === "super@example.org")).toBe(true);
  });
});

// ─── Helpers (post-fix-commit-4 invitation flow) ───────────────────────────

/**
 * Drive an invitation through to a fully-provisioned platform_admins row
 * via the public accept endpoint. Encapsulates: POST invite → DB-read the
 * token → POST accept → return id + keycloakId. Used by the rename /
 * reset / delete tests that need an admin to operate on.
 */
async function inviteAndAccept(opts: {
  email: string;
  firstName: string;
  lastName: string;
  password?: string;
}): Promise<{ id: string; keycloakId: string; invitationId: string }> {
  const invite = await app.inject({
    method: "POST",
    url: "/v1/admin/platform-admins",
    headers: authHeader(superAdminToken()),
    payload: { email: opts.email, firstName: opts.firstName, lastName: opts.lastName },
  });
  if (invite.statusCode !== 201) {
    throw new Error(`inviteAndAccept: invite failed ${invite.statusCode} ${invite.payload}`);
  }
  const inviteBody = invite.json() as { data: { invitationId: string } };
  const invitationId = inviteBody.data.invitationId;

  // Read the token directly from the DB — it's never returned in any
  // API response (SEC-7), and the email is sent out-of-band via the
  // worker which we don't run here.
  const tokenRows = await systemDb.execute<{ token: string }>(
    sql`SELECT token FROM invitations WHERE id = ${invitationId}`,
  );
  const token = tokenRows.rows[0]?.token;
  if (!token) throw new Error("inviteAndAccept: token missing");

  const accept = await app.inject({
    method: "POST",
    url: `/v1/public/platform-admins/invitations/${token}/accept`,
    payload: {
      firstName: opts.firstName,
      lastName: opts.lastName,
      password: opts.password ?? "Test-Password-1234",
    },
  });
  if (accept.statusCode !== 201) {
    throw new Error(`inviteAndAccept: accept failed ${accept.statusCode} ${accept.payload}`);
  }
  const acceptBody = accept.json() as { data: { id: string; keycloakId: string } };
  return { id: acceptBody.data.id, keycloakId: acceptBody.data.keycloakId, invitationId };
}

// ─── Create (invitation flow) ───────────────────────────────────────────────

describe("POST /v1/admin/platform-admins (issue invitation)", () => {
  it("inserts an invitation row + outbox event + audit row; does NOT touch Keycloak", async () => {
    const email = `invitee-${randomUUID().slice(0, 8)}@example.org`;
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/platform-admins",
      headers: authHeader(superAdminToken()),
      payload: { email, firstName: "New", lastName: "Admin" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      data: { invitationId: string; email: string; expiresAt: string };
    };
    expect(body.data.email).toBe(email);
    expect(body.data.invitationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // Post fix-commit-4: KC is NOT contacted at invite time. The row
    // materialises at accept time when the invitee submits the password.
    expect(kcCreateUser).not.toHaveBeenCalled();
    expect(kcAssignRealmRole).not.toHaveBeenCalled();
    expect(kcAttachUserToOrg).not.toHaveBeenCalled();
    expect(kcSendExecuteActions).not.toHaveBeenCalled();

    // Outbox event was inserted for the worker to pick up.
    const outboxRows = await systemDb.execute<{ type: string; payload: { invitationId: string } }>(
      sql`SELECT type, payload FROM outbox_events WHERE payload->>'invitationId' = ${body.data.invitationId}`,
    );
    expect(outboxRows.rows.length).toBe(1);
    expect(outboxRows.rows[0]?.type).toBe("platform_admin.invited");

    // Audit row written under the platform sentinel tenant.
    const auditRows = await systemDb.execute<{ org_id: string; actor_id: string }>(
      sql`SELECT org_id, actor_id FROM audit_logs WHERE resource_id = ${body.data.invitationId} AND action = 'platform_admin.invited'`,
    );
    expect(auditRows.rows.length).toBe(1);
    expect(auditRows.rows[0]?.org_id).toBe(PLATFORM_TENANT_ID);
    expect(auditRows.rows[0]?.actor_id).toBe(SUPER_ADMIN_KEYCLOAK_ID);
  });

  it("refuses (409 + RFC 9457) when the email belongs to a tenant user (ADR-022 invariant)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/platform-admins",
      headers: authHeader(superAdminToken()),
      payload: { email: "user-a@example.org", firstName: "X", lastName: "Y" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      type: "https://httpproblems.com/http-status/409",
      title: "Conflict",
      status: 409,
    });
    expect((res.json() as { detail?: string }).detail ?? "").toMatch(/tenant member/i);
  });

  it("refuses a duplicate pending invitation for the same email", async () => {
    const email = `dup-${randomUUID().slice(0, 8)}@example.org`;
    const first = await app.inject({
      method: "POST",
      url: "/v1/admin/platform-admins",
      headers: authHeader(superAdminToken()),
      payload: { email, firstName: "X", lastName: "Y" },
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: "POST",
      url: "/v1/admin/platform-admins",
      headers: authHeader(superAdminToken()),
      payload: { email, firstName: "X", lastName: "Y" },
    });
    expect(second.statusCode).toBe(409);
    expect((second.json() as { detail?: string }).detail ?? "").toMatch(/pending/i);
  });
});

// ─── Public accept ──────────────────────────────────────────────────────────

describe("Public accept flow", () => {
  it("GET token returns invitation details for a valid token", async () => {
    const email = `probe-${randomUUID().slice(0, 8)}@example.org`;
    const invite = await app.inject({
      method: "POST",
      url: "/v1/admin/platform-admins",
      headers: authHeader(superAdminToken()),
      payload: { email, firstName: "Probe", lastName: "Admin" },
    });
    const invitationId = (invite.json() as { data: { invitationId: string } }).data.invitationId;
    const tokenRows = await systemDb.execute<{ token: string }>(
      sql`SELECT token FROM invitations WHERE id = ${invitationId}`,
    );
    const token = tokenRows.rows[0]?.token;

    const res = await app.inject({
      method: "GET",
      url: `/v1/public/platform-admins/invitations/${token}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { email: string; firstName: string; lastName: string } };
    expect(body.data.email).toBe(email);
    expect(body.data.firstName).toBe("Probe");
    expect(body.data.lastName).toBe("Admin");
  });

  it("GET token returns 404 with RFC 9457 body for a missing/expired token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/public/platform-admins/invitations/00000000-0000-0000-0000-000000000000",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      type: "https://httpproblems.com/http-status/404",
      title: "Not Found",
      status: 404,
    });
  });

  it("POST accept provisions the KC user + role + Org + platform_admins row + audit", async () => {
    const email = `acceptee-${randomUUID().slice(0, 8)}@example.org`;
    const result = await inviteAndAccept({ email, firstName: "Acc", lastName: "Eptee" });

    // KC side-effects fired at accept time.
    expect(kcCreateUser).toHaveBeenCalledTimes(1);
    // The `org_id` user attribute MUST be set on the new admin.
    expect(kcCreateUser.mock.calls[0]?.[0]?.attributes).toMatchObject({
      org_id: [PLATFORM_TENANT_ID],
    });
    // Password is NOT temporary — the invitee just typed it.
    expect(kcCreateUser.mock.calls[0]?.[0]?.temporary).toBe(false);
    expect(kcAssignRealmRole).toHaveBeenCalledTimes(1);
    expect(kcAttachUserToOrg).toHaveBeenCalledTimes(1);

    // platform_admins row exists.
    const rows = await systemDb.execute<{ email: string }>(
      sql`SELECT email FROM platform_admins WHERE id = ${result.id}`,
    );
    expect(rows.rows[0]?.email).toBe(email);

    // Invitation marked accepted.
    const inviteRows = await systemDb.execute<{ accepted_at: string | null }>(
      sql`SELECT accepted_at FROM invitations WHERE id = ${result.invitationId}`,
    );
    expect(inviteRows.rows[0]?.accepted_at).not.toBeNull();

    // Audit `platform_admin.created` written; actor_id null (the invitee
    // accepted themselves; the inviter is on the prior `invited` row).
    const auditRows = await systemDb.execute<{ actor_id: string | null }>(
      sql`SELECT actor_id FROM audit_logs WHERE resource_id = ${result.id} AND action = 'platform_admin.created'`,
    );
    expect(auditRows.rows.length).toBe(1);
    expect(auditRows.rows[0]?.actor_id).toBeNull();
  });

  it("POST accept on an already-accepted token returns 404 + RFC 9457 body", async () => {
    const email = `dbl-${randomUUID().slice(0, 8)}@example.org`;
    const invite = await app.inject({
      method: "POST",
      url: "/v1/admin/platform-admins",
      headers: authHeader(superAdminToken()),
      payload: { email, firstName: "Once", lastName: "Twice" },
    });
    const invitationId = (invite.json() as { data: { invitationId: string } }).data.invitationId;
    const tokenRows = await systemDb.execute<{ token: string }>(
      sql`SELECT token FROM invitations WHERE id = ${invitationId}`,
    );
    const token = tokenRows.rows[0]?.token;

    const first = await app.inject({
      method: "POST",
      url: `/v1/public/platform-admins/invitations/${token}/accept`,
      payload: { firstName: "Once", lastName: "Twice", password: "Test-Password-1234" },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: `/v1/public/platform-admins/invitations/${token}/accept`,
      payload: { firstName: "Once", lastName: "Twice", password: "Test-Password-1234" },
    });
    expect(second.statusCode).toBe(404);
    expect(second.json()).toMatchObject({
      type: "https://httpproblems.com/http-status/404",
      title: "Not Found",
      status: 404,
    });
  });
});

// ─── Rename ─────────────────────────────────────────────────────────────────

describe("PATCH /v1/admin/platform-admins/:id", () => {
  it("renames a platform admin and writes an audit row with old/new values", async () => {
    const email = `rename-${randomUUID().slice(0, 8)}@example.org`;
    const { id } = await inviteAndAccept({
      email,
      firstName: "Before",
      lastName: "Name",
    });
    kcUpdateUser.mockClear();

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/admin/platform-admins/${id}`,
      headers: authHeader(superAdminToken()),
      payload: { firstName: "After", lastName: "Renamed" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: { firstName: string } }).data.firstName).toBe("After");
    expect(kcUpdateUser).toHaveBeenCalledTimes(1);

    const auditRows = await systemDb.execute<{
      old_values: Record<string, unknown>;
      new_values: Record<string, unknown>;
    }>(
      sql`SELECT old_values, new_values FROM audit_logs WHERE resource_id = ${id} AND action = 'platform_admin.renamed'`,
    );
    expect(auditRows.rows.length).toBe(1);
    expect(auditRows.rows[0]?.old_values).toMatchObject({ firstName: "Before" });
    expect(auditRows.rows[0]?.new_values).toMatchObject({ firstName: "After" });
  });
});

// ─── Reset password ─────────────────────────────────────────────────────────

describe("POST /v1/admin/platform-admins/:id/reset-password", () => {
  it("triggers a fresh UPDATE_PASSWORD email and writes an audit row", async () => {
    const email = `reset-${randomUUID().slice(0, 8)}@example.org`;
    const { id } = await inviteAndAccept({ email, firstName: "X", lastName: "Y" });
    kcSendExecuteActions.mockClear();

    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/platform-admins/${id}/reset-password`,
      headers: authHeader(superAdminToken()),
    });
    expect(res.statusCode).toBe(204);
    expect(kcSendExecuteActions).toHaveBeenCalledTimes(1);
    expect(kcSendExecuteActions.mock.calls[0]?.[1]).toEqual(["UPDATE_PASSWORD"]);

    const auditRows = await systemDb.execute(
      sql`SELECT action FROM audit_logs WHERE resource_id = ${id} AND action = 'platform_admin.password_reset_sent'`,
    );
    expect(auditRows.rows.length).toBe(1);
  });
});

// ─── Soft-delete ────────────────────────────────────────────────────────────

describe("DELETE /v1/admin/platform-admins/:id", () => {
  it("refuses self-removal with 400 (operator cannot soft-delete their own row)", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/admin/platform-admins/${SUPER_ADMIN_PLATFORM_ROW_ID}`,
      headers: authHeader(superAdminToken()),
    });
    // Lock RFC 9457 body shape (QA M1).
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      type: "https://httpproblems.com/http-status/400",
      title: "Bad Request",
      status: 400,
    });
    expect((res.json() as { detail?: string }).detail ?? "").toMatch(/own platform-admin row/i);
    expect(kcDeleteUser).not.toHaveBeenCalled();
  });

  it("refuses the last-admin removal with 400", async () => {
    // Create a second admin first, then remove the seeded one — that
    // succeeds — but immediately re-attempt to remove the only remaining
    // admin and expect 400.
    const { id: secondId, keycloakId: secondKc } = await inviteAndAccept({
      email: `second-${randomUUID().slice(0, 8)}@example.org`,
      firstName: "Second",
      lastName: "Admin",
    });

    // Use a fresh token signed as the *second* admin to soft-delete the
    // original (the original cannot self-remove). The second admin has the
    // super_admin realm role injected in the JWT.
    const secondToken = signToken(app, {
      sub: secondKc,
      realm_access: { roles: ["super_admin"] },
      role: undefined,
    });

    const removeOriginal = await app.inject({
      method: "DELETE",
      url: `/v1/admin/platform-admins/${SUPER_ADMIN_PLATFORM_ROW_ID}`,
      headers: authHeader(secondToken),
    });
    expect(removeOriginal.statusCode).toBe(204);

    // Now `second` is the only active admin. Try to delete it from a
    // distinct operator JWT (third synthetic super-admin sub) so the
    // self-removal guard doesn't fire and we hit the last-admin guard.
    const thirdToken = signToken(app, {
      sub: "00000000-0000-0000-0000-0000000000fe",
      realm_access: { roles: ["super_admin"] },
      role: undefined,
    });
    const removeSecond = await app.inject({
      method: "DELETE",
      url: `/v1/admin/platform-admins/${secondId}`,
      headers: authHeader(thirdToken),
    });
    // Lock RFC 9457 body shape on the last-admin path (QA M1).
    expect(removeSecond.statusCode).toBe(400);
    expect(removeSecond.json()).toMatchObject({
      type: "https://httpproblems.com/http-status/400",
      title: "Bad Request",
      status: 400,
    });
    expect((removeSecond.json() as { detail?: string }).detail ?? "").toMatch(/last active/i);
  });

  it("soft-deletes a platform admin: KC user deleted, sub blocklisted, audit row, deleted_at set, keycloak_id cleared", async () => {
    const { id, keycloakId: targetKc } = await inviteAndAccept({
      email: `target-${randomUUID().slice(0, 8)}@example.org`,
      firstName: "Target",
      lastName: "User",
    });
    kcDeleteUser.mockClear();

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/admin/platform-admins/${id}`,
      headers: authHeader(superAdminToken()),
    });
    expect(res.statusCode).toBe(204);

    expect(kcDeleteUser).toHaveBeenCalledWith(targetKc);

    // Sub blocklisted in Redis (zero-second propagation per ADR-021).
    const blocklisted = await redis.get(`auth:user-blocklist:${targetKc}`);
    expect(blocklisted).not.toBeNull();

    // DB state — soft-deleted, keycloak_id nulled.
    const rows = await systemDb.execute<{
      deleted_at: string | null;
      keycloak_id: string | null;
    }>(sql`SELECT deleted_at, keycloak_id FROM platform_admins WHERE id = ${id}`);
    expect(rows.rows[0]?.deleted_at).not.toBeNull();
    expect(rows.rows[0]?.keycloak_id).toBeNull();

    const auditRows = await systemDb.execute(
      sql`SELECT action FROM audit_logs WHERE resource_id = ${id} AND action = 'platform_admin.removed'`,
    );
    expect(auditRows.rows.length).toBe(1);
  });

  // QA review m1 — boundary case for the last-admin guard. The seeded
  // operator is soft-deleted (via a second admin); only one active row
  // remains and the next delete must trip the guard. Pins that the
  // count clause filters `deleted_at IS NULL` rather than counting all
  // rows. (Issue #255.)
  it("last-admin guard counts active rows only: deleting the sole active row when a soft-deleted row exists → 400", async () => {
    // Step 1: invite + accept admin C.
    const { id: cId, keycloakId: cKc } = await inviteAndAccept({
      email: `edge-active-${randomUUID().slice(0, 8)}@example.org`,
      firstName: "Edge",
      lastName: "Active",
    });

    // Step 2: C soft-deletes the seeded operator. After this, the
    // platform_admins table has:
    //   - seeded operator: deleted_at IS NOT NULL
    //   - C:               deleted_at IS NULL  (only active row)
    const cToken = signToken(app, {
      sub: cKc,
      realm_access: { roles: ["super_admin"] },
      role: undefined,
    });
    const removeSeeded = await app.inject({
      method: "DELETE",
      url: `/v1/admin/platform-admins/${SUPER_ADMIN_PLATFORM_ROW_ID}`,
      headers: authHeader(cToken),
    });
    expect(removeSeeded.statusCode).toBe(204);

    // Step 3: a third operator (no platform_admins row, just a JWT)
    // attempts to delete C. The self-removal guard wouldn't fire
    // (third != C), so this lands directly in the last-admin guard.
    const thirdToken = signToken(app, {
      sub: "00000000-0000-0000-0000-0000000000fd",
      realm_access: { roles: ["super_admin"] },
      role: undefined,
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/admin/platform-admins/${cId}`,
      headers: authHeader(thirdToken),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      type: "https://httpproblems.com/http-status/400",
      title: "Bad Request",
      status: 400,
    });
    expect((res.json() as { detail?: string }).detail ?? "").toMatch(/last active/i);
  });

  // QA review M4 — concurrency invariant for the last-admin guard. With
  // two active admins, two operators racing to delete *different*
  // targets must not both succeed (that would leave zero active admins
  // and brick the platform). The service uses SERIALIZABLE + FOR UPDATE
  // to make exactly one win — the loser is either rejected by the
  // count clause (400) or aborted by Postgres SSI (5xx). The test
  // pins the invariant "exactly one of the two requests succeeds";
  // either failure mode satisfies that. (Issue #255, security review M1.)
  it("last-admin guard concurrency: Promise.all on two distinct deletes against the second-to-last admin → exactly one succeeds", async () => {
    // Step 1: two active admins.
    const { id: cId } = await inviteAndAccept({
      email: `race-c-${randomUUID().slice(0, 8)}@example.org`,
      firstName: "RaceC",
      lastName: "Admin",
    });

    // Step 2: two distinct operators (neither is in platform_admins).
    const opD = signToken(app, {
      sub: "00000000-0000-0000-0000-0000000000fa",
      realm_access: { roles: ["super_admin"] },
      role: undefined,
    });
    const opE = signToken(app, {
      sub: "00000000-0000-0000-0000-0000000000fb",
      realm_access: { roles: ["super_admin"] },
      role: undefined,
    });

    // Step 3: race the two deletes. Op D removes the seeded operator,
    // op E removes admin C. Both targets are currently active, both
    // count snapshots see active=2 — the SERIALIZABLE + FOR UPDATE
    // posture must prevent both from committing.
    const [resD, resE] = await Promise.all([
      app.inject({
        method: "DELETE",
        url: `/v1/admin/platform-admins/${SUPER_ADMIN_PLATFORM_ROW_ID}`,
        headers: authHeader(opD),
      }),
      app.inject({
        method: "DELETE",
        url: `/v1/admin/platform-admins/${cId}`,
        headers: authHeader(opE),
      }),
    ]);

    const successes = [resD.statusCode, resE.statusCode].filter((c) => c === 204);
    const failures = [resD.statusCode, resE.statusCode].filter((c) => c !== 204);
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
    // Loser is either 400 (count clause won) or 5xx (Postgres serialization
    // failure bubbled). Either is correct — the invariant is "at least one
    // active admin remains".
    expect(failures[0]).toBeGreaterThanOrEqual(400);

    // Final DB state: exactly one active admin.
    const counts = await systemDb.execute<{ count: number }>(
      sql`SELECT COUNT(*)::int AS count FROM platform_admins WHERE deleted_at IS NULL`,
    );
    expect(Number(counts.rows[0]?.count ?? 0)).toBe(1);
  });
});

// ─── Audit attribution (issue #255, QA review M3) ──────────────────────────
//
// The PR #253 audit-row tests confirmed *that* a row was written, not
// *who* it attributes the event to. These tests pin (`actor_id`,
// `org_id`, `user_id`) on every lifecycle action so a future change to
// the audit-write call site can't silently lose attribution columns.

describe("Audit attribution", () => {
  it("platform_admin.password_reset_sent: actor_id = operator, org_id = platform sentinel, user_id = target's KC sub", async () => {
    const { id, keycloakId: targetKc } = await inviteAndAccept({
      email: `audit-reset-${randomUUID().slice(0, 8)}@example.org`,
      firstName: "AuditReset",
      lastName: "Admin",
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/platform-admins/${id}/reset-password`,
      headers: authHeader(superAdminToken()),
    });
    expect(res.statusCode).toBe(204);

    const rows = await systemDb.execute<{
      actor_id: string | null;
      org_id: string;
      user_id: string | null;
    }>(
      sql`SELECT actor_id, org_id, user_id FROM audit_logs WHERE resource_id = ${id} AND action = 'platform_admin.password_reset_sent'`,
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]?.actor_id).toBe(SUPER_ADMIN_KEYCLOAK_ID);
    expect(rows.rows[0]?.org_id).toBe(PLATFORM_TENANT_ID);
    expect(rows.rows[0]?.user_id).toBe(targetKc);
  });

  it("platform_admin.renamed: actor_id = operator, org_id = platform sentinel, user_id = target's KC sub", async () => {
    const { id, keycloakId: targetKc } = await inviteAndAccept({
      email: `audit-rename-${randomUUID().slice(0, 8)}@example.org`,
      firstName: "AuditRename",
      lastName: "Before",
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/admin/platform-admins/${id}`,
      headers: authHeader(superAdminToken()),
      payload: { firstName: "AuditRename", lastName: "After" },
    });
    expect(res.statusCode).toBe(200);

    const rows = await systemDb.execute<{
      actor_id: string | null;
      org_id: string;
      user_id: string | null;
    }>(
      sql`SELECT actor_id, org_id, user_id FROM audit_logs WHERE resource_id = ${id} AND action = 'platform_admin.renamed'`,
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]?.actor_id).toBe(SUPER_ADMIN_KEYCLOAK_ID);
    expect(rows.rows[0]?.org_id).toBe(PLATFORM_TENANT_ID);
    expect(rows.rows[0]?.user_id).toBe(targetKc);
  });

  it("platform_admin.removed: actor_id = operator, org_id = platform sentinel, user_id = target's pre-soft-delete KC sub", async () => {
    const { id, keycloakId: targetKc } = await inviteAndAccept({
      email: `audit-remove-${randomUUID().slice(0, 8)}@example.org`,
      firstName: "AuditRemove",
      lastName: "Admin",
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/admin/platform-admins/${id}`,
      headers: authHeader(superAdminToken()),
    });
    expect(res.statusCode).toBe(204);

    const rows = await systemDb.execute<{
      actor_id: string | null;
      org_id: string;
      user_id: string | null;
    }>(
      sql`SELECT actor_id, org_id, user_id FROM audit_logs WHERE resource_id = ${id} AND action = 'platform_admin.removed'`,
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]?.actor_id).toBe(SUPER_ADMIN_KEYCLOAK_ID);
    expect(rows.rows[0]?.org_id).toBe(PLATFORM_TENANT_ID);
    // user_id captures the KC sub at delete time (read inside the
    // SERIALIZABLE tx before the row's keycloak_id is nulled), so
    // post-delete the audit row still attributes to the offboarded sub.
    expect(rows.rows[0]?.user_id).toBe(targetKc);
  });
});

// ─── End-to-end happy path (issue #255, QA review m5) ───────────────────────
//
// One walk that exercises every endpoint on a single id, in order:
//   POST invite → accept → GET detail → PATCH rename → POST reset-password
//   → DELETE soft-delete. Catches regressions where any single endpoint
//   regresses the invariants of the next (e.g. PATCH not refreshing
//   `updated_at`, DELETE forgetting to null `keycloak_id`).

describe("E2E happy path", () => {
  it("invite → accept → GET → PATCH → reset-password → DELETE on the same id", async () => {
    const email = `e2e-${randomUUID().slice(0, 8)}@example.org`;

    // 1. Invite + accept (helper covers POST + GET-token + POST-accept).
    const { id, keycloakId } = await inviteAndAccept({
      email,
      firstName: "E2E",
      lastName: "Walk",
    });

    // 2. GET detail returns the row we just created.
    const getRes = await app.inject({
      method: "GET",
      url: `/v1/admin/platform-admins/${id}`,
      headers: authHeader(superAdminToken()),
    });
    expect(getRes.statusCode).toBe(200);
    const detail = (getRes.json() as { data: { email: string; firstName: string } }).data;
    expect(detail.email).toBe(email);
    expect(detail.firstName).toBe("E2E");

    // 3. PATCH rename — value changes are reflected in the response.
    const patchRes = await app.inject({
      method: "PATCH",
      url: `/v1/admin/platform-admins/${id}`,
      headers: authHeader(superAdminToken()),
      payload: { firstName: "Renamed", lastName: "Walk" },
    });
    expect(patchRes.statusCode).toBe(200);
    expect((patchRes.json() as { data: { firstName: string } }).data.firstName).toBe("Renamed");

    // 4. POST reset-password — KC fake observed once.
    kcSendExecuteActions.mockClear();
    const resetRes = await app.inject({
      method: "POST",
      url: `/v1/admin/platform-admins/${id}/reset-password`,
      headers: authHeader(superAdminToken()),
    });
    expect(resetRes.statusCode).toBe(204);
    expect(kcSendExecuteActions).toHaveBeenCalledTimes(1);
    expect(kcSendExecuteActions.mock.calls[0]?.[0]).toBe(keycloakId);

    // 5. DELETE soft-delete — KC user deleted, audit + soft-delete state
    // applied.
    kcDeleteUser.mockClear();
    const delRes = await app.inject({
      method: "DELETE",
      url: `/v1/admin/platform-admins/${id}`,
      headers: authHeader(superAdminToken()),
    });
    expect(delRes.statusCode).toBe(204);
    expect(kcDeleteUser).toHaveBeenCalledWith(keycloakId);

    // The full lifecycle audit chain is queryable on the resource id.
    const chain = await systemDb.execute<{ action: string }>(
      sql`SELECT action FROM audit_logs WHERE resource_id = ${id} ORDER BY created_at ASC`,
    );
    const actions = chain.rows.map((r) => r.action);
    // `platform_admin.invited` lands on the *invitation* id (not this
    // platform_admins.id), so we expect the post-accept lifecycle here:
    // created → renamed → password_reset_sent → removed.
    expect(actions).toEqual([
      "platform_admin.created",
      "platform_admin.renamed",
      "platform_admin.password_reset_sent",
      "platform_admin.removed",
    ]);
  });
});
