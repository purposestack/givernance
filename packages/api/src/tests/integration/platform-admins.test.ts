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
  await db.execute(sql`
    INSERT INTO platform_admins (id, keycloak_id, email, first_name, last_name)
    VALUES (${SUPER_ADMIN_PLATFORM_ROW_ID}, ${SUPER_ADMIN_KEYCLOAK_ID}, 'super@example.org', 'Super', 'Admin')
    ON CONFLICT (id) DO UPDATE SET deleted_at = NULL, keycloak_id = ${SUPER_ADMIN_KEYCLOAK_ID}, first_name = 'Super', last_name = 'Admin'
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

// ─── Create ─────────────────────────────────────────────────────────────────

describe("POST /v1/admin/platform-admins", () => {
  it("creates a platform admin: KC user + role + Org membership + UPDATE_PASSWORD email + audit row", async () => {
    const email = `new-admin-${randomUUID().slice(0, 8)}@example.org`;
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/platform-admins",
      headers: authHeader(superAdminToken()),
      payload: { email, firstName: "New", lastName: "Admin" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { data: { id: string; keycloakId: string; email: string } };
    expect(body.data.email).toBe(email);
    expect(typeof body.data.keycloakId).toBe("string");

    // KC side-effects all fired.
    expect(kcCreateUser).toHaveBeenCalledTimes(1);
    // The `org_id` user attribute MUST be set on the new admin or the
    // JWT will lack the top-level `org_id` claim that
    // `verifyKeycloakJwt` requires (caught in dev: PR #253 review).
    expect(kcCreateUser.mock.calls[0]?.[0]?.attributes).toMatchObject({
      org_id: [PLATFORM_TENANT_ID],
    });
    expect(kcAssignRealmRole).toHaveBeenCalledTimes(1);
    expect(kcAssignRealmRole.mock.calls[0]?.[1]).toMatchObject({ name: "super_admin" });
    expect(kcAttachUserToOrg).toHaveBeenCalledTimes(1);
    expect(kcSendExecuteActions).toHaveBeenCalledTimes(1);
    expect(kcSendExecuteActions.mock.calls[0]?.[1]).toEqual(["UPDATE_PASSWORD"]);

    // Audit row was written under the platform sentinel tenant.
    const auditRows = await systemDb.execute<{
      action: string;
      org_id: string;
      actor_id: string;
    }>(
      sql`SELECT action, org_id, actor_id FROM audit_logs WHERE resource_id = ${body.data.id} AND action = 'platform_admin.created'`,
    );
    expect(auditRows.rows.length).toBe(1);
    expect(auditRows.rows[0]?.org_id).toBe(PLATFORM_TENANT_ID);
    expect(auditRows.rows[0]?.actor_id).toBe(SUPER_ADMIN_KEYCLOAK_ID);
  });

  it("refuses (409 + RFC 9457) when the email belongs to a tenant user (ADR-022 invariant)", async () => {
    // user-a@example.org is seeded by `ensureTestTenants` in setup.ts.
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
    // KC must not be touched on the invariant rejection — fail fast.
    expect(kcCreateUser).not.toHaveBeenCalled();
  });

  it("returns 502 when the super_admin realm role is missing in Keycloak (operator-visible misconfig)", async () => {
    kcGetRealmRole.mockResolvedValueOnce(null);
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/platform-admins",
      headers: authHeader(superAdminToken()),
      payload: {
        email: `kc-fail-${randomUUID().slice(0, 8)}@example.org`,
        firstName: "X",
        lastName: "Y",
      },
    });
    // Lock the RFC 9457 body shape on this error path (QA M1).
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({
      type: "https://httpproblems.com/http-status/502",
      title: "Bad Gateway",
      status: 502,
    });
    expect((res.json() as { detail?: string }).detail ?? "").toMatch(/role.*super_admin/);
    expect(kcCreateUser).not.toHaveBeenCalled();
  });

  it("rolls back the KC user when assignRealmRole fails mid-flight (locks 502 body shape)", async () => {
    kcAssignRealmRole.mockRejectedValueOnce(new Error("simulated KC failure"));
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/platform-admins",
      headers: authHeader(superAdminToken()),
      payload: {
        email: `compensating-role-${randomUUID().slice(0, 8)}@example.org`,
        firstName: "X",
        lastName: "Y",
      },
    });
    // Lock the RFC 9457 body shape on the compensating-delete path (QA M1 + M2).
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({
      type: "https://httpproblems.com/http-status/502",
      title: "Bad Gateway",
      status: 502,
    });
    expect(kcDeleteUser).toHaveBeenCalledTimes(1);
  });

  // QA review M2 — extend compensating-delete coverage from 1 of 3 KC
  // failure points to 2 of 3. The third (sendExecuteActionsEmail) now has
  // distinct semantics post-fix-commit-1 (no rollback), so it gets its
  // own dedicated test below.
  it("rolls back the KC user when attachUserToOrg fails mid-flight", async () => {
    kcAttachUserToOrg.mockRejectedValueOnce(new Error("simulated KC org failure"));
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/platform-admins",
      headers: authHeader(superAdminToken()),
      payload: {
        email: `compensating-org-${randomUUID().slice(0, 8)}@example.org`,
        firstName: "X",
        lastName: "Y",
      },
    });
    expect(res.statusCode).toBe(502);
    expect(kcDeleteUser).toHaveBeenCalledTimes(1);
  });

  it(
    "does NOT roll back the KC user on email-delivery failure — row is created and 502 references it",
    async () => {
      // Platform review M2 — sendExecuteActionsEmail failure used to nuke
      // the whole KC user. Post-fix-commit-1, the row is preserved and the
      // operator can retry via /reset-password.
      kcSendExecuteActions.mockRejectedValueOnce(new Error("simulated SMTP failure"));
      const res = await app.inject({
        method: "POST",
        url: "/v1/admin/platform-admins",
        headers: authHeader(superAdminToken()),
        payload: {
          email: `email-fail-${randomUUID().slice(0, 8)}@example.org`,
          firstName: "X",
          lastName: "Y",
        },
      });
      expect(res.statusCode).toBe(502);
      // Compensating delete must NOT have fired — KC user retained.
      expect(kcDeleteUser).not.toHaveBeenCalled();
      // The detail message references `/reset-password` so the operator
      // knows the retry path.
      expect((res.json() as { detail?: string }).detail ?? "").toMatch(/reset-password/);
      // The row exists in the DB and is queryable. Extract the id from
      // the detail string (`id=<uuid>`).
      const detail = (res.json() as { detail?: string }).detail ?? "";
      const idMatch = /id=([0-9a-f-]{36})/.exec(detail);
      expect(idMatch?.[1]).toBeTruthy();
      const rows = await systemDb.execute(
        sql`SELECT id FROM platform_admins WHERE id = ${idMatch?.[1]} AND deleted_at IS NULL`,
      );
      expect(rows.rows.length).toBe(1);
    },
  );
});

// ─── Rename ─────────────────────────────────────────────────────────────────

describe("PATCH /v1/admin/platform-admins/:id", () => {
  it("renames a platform admin and writes an audit row with old/new values", async () => {
    const email = `rename-${randomUUID().slice(0, 8)}@example.org`;
    const create = await app.inject({
      method: "POST",
      url: "/v1/admin/platform-admins",
      headers: authHeader(superAdminToken()),
      payload: { email, firstName: "Before", lastName: "Name" },
    });
    expect(create.statusCode).toBe(201);
    const id = (create.json() as { data: { id: string } }).data.id;

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
    const create = await app.inject({
      method: "POST",
      url: "/v1/admin/platform-admins",
      headers: authHeader(superAdminToken()),
      payload: { email, firstName: "X", lastName: "Y" },
    });
    expect(create.statusCode).toBe(201);
    const id = (create.json() as { data: { id: string } }).data.id;
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
    const second = await app.inject({
      method: "POST",
      url: "/v1/admin/platform-admins",
      headers: authHeader(superAdminToken()),
      payload: {
        email: `second-${randomUUID().slice(0, 8)}@example.org`,
        firstName: "Second",
        lastName: "Admin",
      },
    });
    expect(second.statusCode).toBe(201);
    const secondId = (second.json() as { data: { id: string } }).data.id;
    const secondKc = (second.json() as { data: { keycloakId: string } }).data.keycloakId;

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
    const created = await app.inject({
      method: "POST",
      url: "/v1/admin/platform-admins",
      headers: authHeader(superAdminToken()),
      payload: {
        email: `target-${randomUUID().slice(0, 8)}@example.org`,
        firstName: "Target",
        lastName: "User",
      },
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { data: { id: string } }).data.id;
    const targetKc = (created.json() as { data: { keycloakId: string } }).data.keycloakId;

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
});
