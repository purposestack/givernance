/**
 * Issue #24 — coexistence of delegation and pure-impersonation modes.
 *
 * Hits a real Postgres (per `tests/setup.ts`) and a real Redis. The
 * impersonation cookie set by `POST /v1/admin/impersonation` is reused
 * verbatim on subsequent requests so the auth plugin's HS256 verification +
 * Redis lookup are exercised end-to-end.
 */

import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { env } from "../../env.js";
import { db } from "../../lib/db.js";
import {
  IMPERSONATION_DENIED_LOCKOUT_THRESHOLD,
  IMPERSONATION_MAX_STARTS_PER_24H,
} from "../../lib/impersonation/redis-store.js";
import { redis } from "../../lib/redis.js";
import { createServer } from "../../server.js";
import {
  authHeader,
  ensureTestTenants,
  ORG_A,
  ORG_B,
  signToken,
  USER_A,
  USER_B,
} from "../helpers/auth.js";

const SUPER_ADMIN_KEYCLOAK_ID = "00000000-0000-0000-0000-0000000000ad";
const TARGET_USER_APP_ID = "00000000-0000-0000-0000-0000000aaaaa";
// UUID-formatted Keycloak ids — the audit_logs response schema (and the
// admin tests) expect `user_id` to look UUID-shaped because every other
// test signs tokens with UUIDs as `sub`. Using a non-UUID here pollutes
// the table and breaks unrelated audit tests.
const TARGET_USER_KEYCLOAK_ID = "00000000-0000-0000-0000-0000000aa101";
const TARGET_SUPER_ADMIN_APP_ID = "00000000-0000-0000-0000-0000000aaaab";
const TARGET_SUPER_ADMIN_KEYCLOAK_ID = "00000000-0000-0000-0000-0000000aa102";
// Platform-admin target — used by the nested-impersonation test (QA F1)
// to exercise the service-side guard that rejects targets which are
// platform admins (ADR-022). The fixture inserts BOTH a `platform_admins`
// row keyed on PLATFORM_TARGET_KEYCLOAK_ID AND a regular `users` row in
// ORG_A sharing that keycloak_id, so the impersonation service resolves
// a tenant user (it looks up `users` by app id) but the
// `isPlatformAdmin(target.keycloakId)` post-check fires.
const PLATFORM_TARGET_APP_ID = "00000000-0000-0000-0000-0000000aaa01";
const PLATFORM_TARGET_KEYCLOAK_ID = "00000000-0000-0000-0000-0000000aa103";
// Viewer-role target — used to verify pure-impersonation honours the
// target's RBAC (writes 403 because the target is read-only) without any
// extra write-block plugin (issue #24: "impersonation = permissions du
// user cible uniquement").
const VIEWER_TARGET_APP_ID = "00000000-0000-0000-0000-0000000aaa02";
const VIEWER_TARGET_KEYCLOAK_ID = "00000000-0000-0000-0000-0000000aa104";

let app: FastifyInstance;

beforeAll(async () => {
  app = await createServer();
  await app.ready();

  await ensureTestTenants();

  // Seed target users for ORG_A. The PLATFORM_TARGET fixture lives in
  // ORG_A like a normal customer-tenant member; the
  // `isPlatformAdmin(keycloakId)` guard (ADR-022) is what rejects it,
  // not its tenant binding.
  await db.execute(sql`
    DELETE FROM users WHERE id IN (${TARGET_USER_APP_ID}, ${TARGET_SUPER_ADMIN_APP_ID}, ${PLATFORM_TARGET_APP_ID}, ${VIEWER_TARGET_APP_ID})
  `);
  await db.execute(sql`
    INSERT INTO users (id, org_id, keycloak_id, email, first_name, last_name, role)
    VALUES
      (${TARGET_USER_APP_ID}, ${ORG_A}, ${TARGET_USER_KEYCLOAK_ID}, 'target@example.org', 'Target', 'User', 'org_admin'),
      (${TARGET_SUPER_ADMIN_APP_ID}, ${ORG_A}, ${TARGET_SUPER_ADMIN_KEYCLOAK_ID}, 'super@example.org', 'Target', 'SuperAdmin', 'org_admin'),
      (${PLATFORM_TARGET_APP_ID}, ${ORG_A}, ${PLATFORM_TARGET_KEYCLOAK_ID}, 'platform-target@example.org', 'Platform', 'Target', 'org_admin'),
      (${VIEWER_TARGET_APP_ID}, ${ORG_A}, ${VIEWER_TARGET_KEYCLOAK_ID}, 'viewer-target@example.org', 'Viewer', 'Target', 'viewer')
  `);

  // ADR-022: insert a `platform_admins` row sharing the
  // PLATFORM_TARGET_KEYCLOAK_ID so the nested-impersonation guard fires.
  // Idempotent — `ON CONFLICT DO NOTHING` so the test suite is re-runnable.
  await db.execute(sql`
    INSERT INTO platform_admins (keycloak_id, email, first_name, last_name)
    VALUES (${PLATFORM_TARGET_KEYCLOAK_ID}, 'platform-admin-fixture@example.org', 'Platform', 'AdminFixture')
    ON CONFLICT DO NOTHING
  `);
});

afterAll(async () => {
  await app.close();
});

afterEach(async () => {
  // Wipe any session/lockout/rate-limit state so test ordering doesn't bleed.
  const keys = [
    ...(await redis.keys("impersonation:session:*")),
    ...(await redis.keys("impersonation:revoked:*")),
    ...(await redis.keys("impersonation:ratelimit:*")),
    ...(await redis.keys("impersonation:denied:*")),
  ];
  if (keys.length) await redis.del(...keys);
  await db.execute(
    sql`UPDATE impersonation_sessions SET ended_at = NOW(), end_reason = 'manual' WHERE ended_at IS NULL`,
  );
});

function superAdminToken(claims: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return signToken(app, {
    sub: SUPER_ADMIN_KEYCLOAK_ID,
    org_id: ORG_A,
    realm_access: { roles: ["super_admin"] },
    role: undefined,
    auth_time: now - 30,
    acr: "1",
    ...claims,
  });
}

const VALID_REASON = "Support ticket #1234 — receipt PDF download is failing for this user";

function extractImpersonationCookie(setCookieHeader: string | string[] | undefined): string | null {
  if (!setCookieHeader) return null;
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const h of headers) {
    const match = /(?:^|;\s*)givernance_jwt=([^;]+)/.exec(h);
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * Cookie-authenticated mutating requests must carry a matching CSRF
 * double-submit token (the auth plugin enforces this on every non-safe
 * method when a JWT cookie is present). Tests that use the impersonation
 * cookie for POST/DELETE need the cookie + matching header.
 */
const CSRF_TOKEN = "csrf-impersonation-test";
function impersonationCookieHeaders(impersonationToken: string) {
  return {
    cookie: `givernance_jwt=${impersonationToken}; csrf-token=${CSRF_TOKEN}`,
    "x-csrf-token": CSRF_TOKEN,
  };
}

// ─── RBAC + access ─────────────────────────────────────────────────────────

describe("POST /v1/admin/impersonation — RBAC + step-up", () => {
  it("non-super_admin gets 404 (anti-disclosure)", async () => {
    const token = signToken(app, { auth_time: Math.floor(Date.now() / 1000) - 60 });
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/impersonation",
      headers: authHeader(token),
      payload: { targetUserId: TARGET_USER_APP_ID, mode: "delegation", reason: VALID_REASON },
    });
    expect(res.statusCode).toBe(404);
  });

  // In dev (the default test env, IMPERSONATION_REQUIRE_ACR_2=false) the
  // step-up gate is permissive: auth_time freshness is a proxy for "recent
  // MFA challenge," and there's no MFA in dev, so it doesn't fire.
  // The production-mode behaviour (both gates fire together) is covered by
  // the `validateStepUp` unit test in step-up.test.ts.
  it("permissive step-up in dev: missing auth_time still succeeds", async () => {
    const token = superAdminToken({ auth_time: undefined });
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/impersonation",
      headers: authHeader(token),
      payload: { targetUserId: TARGET_USER_APP_ID, mode: "delegation", reason: VALID_REASON },
    });
    expect(res.statusCode).toBe(201);
  });

  it("permissive step-up in dev: stale auth_time still succeeds", async () => {
    const token = superAdminToken({ auth_time: Math.floor(Date.now() / 1000) - 600 });
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/impersonation",
      headers: authHeader(token),
      payload: { targetUserId: TARGET_USER_APP_ID, mode: "delegation", reason: VALID_REASON },
    });
    expect(res.statusCode).toBe(201);
  });

  it("reason shorter than 20 chars returns 400 with field error", async () => {
    const token = superAdminToken();
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/impersonation",
      headers: authHeader(token),
      payload: { targetUserId: TARGET_USER_APP_ID, mode: "delegation", reason: "too short" },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body).toMatchObject({ status: 400, title: expect.any(String) });
  });

  it("blocks impersonating a platform admin (nested impersonation) with 400", async () => {
    const token = superAdminToken();
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/impersonation",
      headers: authHeader(token),
      payload: { targetUserId: PLATFORM_TARGET_APP_ID, mode: "delegation", reason: VALID_REASON },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      type: "https://httpproblems.com/http-status/400",
      title: "Bad Request",
      status: 400,
    });
    expect((res.json() as { detail?: string }).detail ?? "").toMatch(/platform admin/i);
  });

  it("rejects target user without a Keycloak identity", async () => {
    await db.execute(
      sql`UPDATE users SET keycloak_id = NULL WHERE id = ${TARGET_SUPER_ADMIN_APP_ID}`,
    );
    const token = superAdminToken();
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/impersonation",
      headers: authHeader(token),
      payload: {
        targetUserId: TARGET_SUPER_ADMIN_APP_ID,
        mode: "delegation",
        reason: VALID_REASON,
      },
    });
    expect([400, 404]).toContain(res.statusCode);
    // Restore for subsequent tests.
    await db.execute(
      sql`UPDATE users SET keycloak_id = ${TARGET_SUPER_ADMIN_KEYCLOAK_ID} WHERE id = ${TARGET_SUPER_ADMIN_APP_ID}`,
    );
  });

  it("rejects target user that doesn't exist", async () => {
    const token = superAdminToken();
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/impersonation",
      headers: authHeader(token),
      payload: {
        targetUserId: "00000000-0000-0000-0000-000000000fff",
        mode: "delegation",
        reason: VALID_REASON,
      },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ─── Successful start (both modes) ─────────────────────────────────────────

describe("POST /v1/admin/impersonation — successful start (both modes)", () => {
  it("delegation: creates session, sets cookie, returns full payload", async () => {
    const token = superAdminToken();
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/impersonation",
      headers: authHeader(token),
      payload: { targetUserId: TARGET_USER_APP_ID, mode: "delegation", reason: VALID_REASON },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.data).toMatchObject({
      mode: "delegation",
      targetOrgId: ORG_A,
      targetUserId: TARGET_USER_APP_ID,
    });
    expect(typeof body.data.token).toBe("string");
    expect(typeof body.data.sessionId).toBe("string");

    const cookie = extractImpersonationCookie(res.headers["set-cookie"]);
    expect(cookie).toBeTruthy();
    expect(cookie).toBe(body.data.token);

    const session = await db.execute(
      sql`SELECT mode, target_keycloak_id, target_org_id FROM impersonation_sessions WHERE id = ${body.data.sessionId}`,
    );
    expect(session.rows[0]).toMatchObject({
      mode: "delegation",
      target_keycloak_id: TARGET_USER_KEYCLOAK_ID,
      target_org_id: ORG_A,
    });
  });

  it("impersonation: creates session, distinct mode, distinct expiry", async () => {
    const token = superAdminToken();
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/impersonation",
      headers: authHeader(token),
      payload: { targetUserId: TARGET_USER_APP_ID, mode: "impersonation", reason: VALID_REASON },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.data.mode).toBe("impersonation");
    const expiresMs = new Date(body.data.expiresAt).getTime() - Date.now();
    // Default impersonation TTL is 30 min — capped at 1h. We accept anything
    // shorter than 65 min so dev override via env doesn't break the test.
    expect(expiresMs).toBeLessThan(65 * 60 * 1000);
  });

  it("blocks starting a session from inside another impersonation session (409)", async () => {
    const token = superAdminToken();
    const first = await app.inject({
      method: "POST",
      url: "/v1/admin/impersonation",
      headers: authHeader(token),
      payload: { targetUserId: TARGET_USER_APP_ID, mode: "delegation", reason: VALID_REASON },
    });
    expect(first.statusCode).toBe(201);
    const cookie = extractImpersonationCookie(first.headers["set-cookie"]);
    expect(cookie).toBeTruthy();

    const nested = await app.inject({
      method: "POST",
      url: "/v1/admin/impersonation",
      headers: impersonationCookieHeaders(cookie ?? ""),
      payload: { targetUserId: TARGET_USER_APP_ID, mode: "impersonation", reason: VALID_REASON },
    });
    expect(nested.statusCode).toBe(409);
  });
});

// ─── Mode-specific permission isolation ────────────────────────────────────

/**
 * Issue #24 acceptance criterion: "impersonation = permissions du user
 * cible uniquement". RBAC is the only gate; no extra write-block.
 *   - impersonating a write-capable target → writes succeed
 *   - impersonating a viewer (read-only)   → writes 403 via existing RBAC
 *   - delegation                            → super_admin retained → writes succeed
 */
describe("Permission isolation honours the target's role (no extra write-block)", () => {
  async function startSession(targetUserId: string, mode: "delegation" | "impersonation") {
    const token = superAdminToken();
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/impersonation",
      headers: authHeader(token),
      payload: { targetUserId, mode, reason: VALID_REASON },
    });
    expect(res.statusCode).toBe(201);
    const cookie = extractImpersonationCookie(res.headers["set-cookie"]);
    if (!cookie) throw new Error("missing impersonation cookie");
    return { cookie, sessionId: JSON.parse(res.payload).data.sessionId };
  }

  it("pure impersonation: GET /v1/constituents passes (read allowed)", async () => {
    const { cookie } = await startSession(TARGET_USER_APP_ID, "impersonation");
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents",
      headers: { cookie: `givernance_jwt=${cookie}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("pure impersonation as org_admin target: writes SUCCEED (target has write role)", async () => {
    const { cookie } = await startSession(TARGET_USER_APP_ID, "impersonation");
    const stamp = Date.now().toString(36);
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: { ...impersonationCookieHeaders(cookie), "content-type": "application/json" },
      payload: {
        firstName: `Repro-${stamp}`,
        lastName: `Bug-${stamp}`,
        type: "donor",
      },
    });
    expect([200, 201]).toContain(res.statusCode);
  });

  it("pure impersonation as VIEWER target: writes 403 via target's RBAC (no extra block)", async () => {
    const { cookie } = await startSession(VIEWER_TARGET_APP_ID, "impersonation");
    const stamp = Date.now().toString(36);
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: { ...impersonationCookieHeaders(cookie), "content-type": "application/json" },
      payload: {
        firstName: `Viewer-${stamp}`,
        lastName: `Blocked-${stamp}`,
        type: "donor",
      },
    });
    // 403 from `requireWrite` because the target is `viewer` — same
    // response a real viewer would get logging in directly. No "read-only"
    // detail string; this is the standard RBAC denial.
    expect(res.statusCode).toBe(403);
  });

  it("operator can end their own session from inside a pure-impersonation cookie", async () => {
    const { cookie, sessionId } = await startSession(TARGET_USER_APP_ID, "impersonation");
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/admin/impersonation/${sessionId}`,
      headers: impersonationCookieHeaders(cookie),
    });
    expect(res.statusCode).toBe(204);
  });

  it("delegation: POST /v1/constituents IS allowed (super_admin retained)", async () => {
    const { cookie } = await startSession(TARGET_USER_APP_ID, "delegation");
    const stamp = Date.now().toString(36);
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: { ...impersonationCookieHeaders(cookie), "content-type": "application/json" },
      payload: { firstName: `Delegated-${stamp}`, lastName: `Write-${stamp}`, type: "donor" },
    });
    expect([200, 201]).toContain(res.statusCode);
  });

  // GET /v1/users/me used to route by realm role: any token carrying
  // `super_admin` was answered out of `platform_admins`. Delegation mode
  // KEEPS `super_admin` in `realm_access.roles` (that's the whole point of
  // delegation — the operator's super-powers travel with the session) but
  // the JWT's `sub` is the TARGET, who has no `platform_admins` row. The
  // route therefore 404'd every delegation session, blanking the org name
  // and role on the client and silently degrading the sidebar's settings
  // link. The fix routes by `auth.impersonation` (the canonical "this is
  // a session" discriminator), so /me always answers from the target's
  // perspective during a session — regardless of which realm role the
  // operator brought in.
  it("delegation /v1/users/me returns the TARGET's tenant profile (not 404)", async () => {
    const { cookie } = await startSession(TARGET_USER_APP_ID, "delegation");
    const res = await app.inject({
      method: "GET",
      url: "/v1/users/me",
      headers: { cookie: `givernance_jwt=${cookie}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.data).toMatchObject({
      keycloakId: TARGET_USER_KEYCLOAK_ID,
      role: "org_admin",
      orgId: ORG_A,
    });
    // orgName comes from the tenants table; just assert it's non-empty so
    // the sidebar's `user?.orgName ?? placeholder` branch resolves.
    expect(typeof body.data.orgName).toBe("string");
    expect(body.data.orgName.length).toBeGreaterThan(0);
  });

  it("pure impersonation /v1/users/me returns the TARGET's tenant profile", async () => {
    const { cookie } = await startSession(TARGET_USER_APP_ID, "impersonation");
    const res = await app.inject({
      method: "GET",
      url: "/v1/users/me",
      headers: { cookie: `givernance_jwt=${cookie}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.data).toMatchObject({
      keycloakId: TARGET_USER_KEYCLOAK_ID,
      role: "org_admin",
      orgId: ORG_A,
    });
  });
});

// ─── Audit double-attribution ──────────────────────────────────────────────

describe("Audit double-attribution + mode discriminator", () => {
  it("delegation: audit row has actor_id=operator, user_id=target, mode=delegation", async () => {
    const token = superAdminToken();
    const start = await app.inject({
      method: "POST",
      url: "/v1/admin/impersonation",
      headers: authHeader(token),
      payload: { targetUserId: TARGET_USER_APP_ID, mode: "delegation", reason: VALID_REASON },
    });
    expect(start.statusCode).toBe(201);

    const sessionId = JSON.parse(start.payload).data.sessionId;
    const lifecycle = await db.execute(sql`
      SELECT user_id, actor_id, impersonation_session_id, impersonation_mode, action
        FROM audit_logs
       WHERE impersonation_session_id = ${sessionId}
         AND action = 'impersonation.started'
       LIMIT 1
    `);
    expect(lifecycle.rows[0]).toMatchObject({
      user_id: TARGET_USER_KEYCLOAK_ID,
      actor_id: SUPER_ADMIN_KEYCLOAK_ID,
      impersonation_session_id: sessionId,
      impersonation_mode: "delegation",
    });
  });

  it("impersonation: lifecycle audit row carries mode=impersonation", async () => {
    const token = superAdminToken();
    const start = await app.inject({
      method: "POST",
      url: "/v1/admin/impersonation",
      headers: authHeader(token),
      payload: { targetUserId: TARGET_USER_APP_ID, mode: "impersonation", reason: VALID_REASON },
    });
    const sessionId = JSON.parse(start.payload).data.sessionId;
    const lifecycle = await db.execute(sql`
      SELECT impersonation_mode
        FROM audit_logs
       WHERE impersonation_session_id = ${sessionId}
       LIMIT 1
    `);
    expect(lifecycle.rows[0]?.impersonation_mode).toBe("impersonation");
  });
});

// ─── Lifecycle + revocation ────────────────────────────────────────────────

describe("Session end / revocation invalidates the cookie", () => {
  it("after DELETE, the same cookie returns 401 with impersonation_revoked discriminator", async () => {
    const token = superAdminToken();
    const start = await app.inject({
      method: "POST",
      url: "/v1/admin/impersonation",
      headers: authHeader(token),
      payload: { targetUserId: TARGET_USER_APP_ID, mode: "delegation", reason: VALID_REASON },
    });
    const cookie = extractImpersonationCookie(start.headers["set-cookie"]);
    const sessionId = JSON.parse(start.payload).data.sessionId;

    const end = await app.inject({
      method: "DELETE",
      url: `/v1/admin/impersonation/${sessionId}`,
      headers: impersonationCookieHeaders(cookie ?? ""),
    });
    expect(end.statusCode).toBe(204);

    const replay = await app.inject({
      method: "GET",
      url: "/v1/constituents",
      headers: { cookie: `givernance_jwt=${cookie}` },
    });
    expect(replay.statusCode).toBe(401);
    expect(JSON.parse(replay.payload).detail).toMatch(/Impersonation/);
  });
});

// ─── Rate limit + lockout ──────────────────────────────────────────────────

describe("Rate limit + lockout", () => {
  it(`returns 429 once start count exceeds ${IMPERSONATION_MAX_STARTS_PER_24H}/24h`, async () => {
    const token = superAdminToken();
    // Pre-warm the counter so we don't have to hit the endpoint 11 times —
    // the route increments AFTER each successful start, so seeding to N
    // means the next call increments to N+1 which trips the cap.
    await redis.set(
      `impersonation:ratelimit:start:${SUPER_ADMIN_KEYCLOAK_ID}`,
      String(IMPERSONATION_MAX_STARTS_PER_24H),
      "EX",
      24 * 3600,
    );

    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/impersonation",
      headers: authHeader(token),
      payload: { targetUserId: TARGET_USER_APP_ID, mode: "delegation", reason: VALID_REASON },
    });
    expect(res.statusCode).toBe(429);
  });

  it(`returns 423 (Locked) after ${IMPERSONATION_DENIED_LOCKOUT_THRESHOLD} consecutive step-up failures`, async () => {
    // Pre-seed the lockout counter so we don't burn five real failures.
    await redis.set(
      `impersonation:denied:${SUPER_ADMIN_KEYCLOAK_ID}`,
      String(IMPERSONATION_DENIED_LOCKOUT_THRESHOLD),
      "EX",
      15 * 60,
    );

    const token = superAdminToken();
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/impersonation",
      headers: authHeader(token),
      payload: { targetUserId: TARGET_USER_APP_ID, mode: "delegation", reason: VALID_REASON },
    });
    expect(res.statusCode).toBe(423);
  });
});

// ─── Strict step-up (production-mode) ──────────────────────────────────────
//
// Production sets IMPERSONATION_REQUIRE_ACR_2=true (env.ts boot check).
// These tests flip the runtime env flag for the duration of the block to
// exercise the strict-mode 401 response shape that issue #250 added —
// the web side keys off `step_up_required` to redirect the operator
// through Keycloak with `acr_values=2`. Without this coverage the new
// extension members can silently regress to undefined and the form
// degrades to a generic-error toast (the original bug).

describe("POST /v1/admin/impersonation — strict step-up (issue #250)", () => {
  let originalRequireAcr2: boolean;

  beforeAll(() => {
    originalRequireAcr2 = env.IMPERSONATION_REQUIRE_ACR_2;
    env.IMPERSONATION_REQUIRE_ACR_2 = true;
  });

  afterAll(() => {
    env.IMPERSONATION_REQUIRE_ACR_2 = originalRequireAcr2;
  });

  it("acr=1 (LoA insufficient) → 401 with reason=acr_insufficient + step_up_required=true", async () => {
    const token = superAdminToken({ acr: "1", auth_time: Math.floor(Date.now() / 1000) - 30 });
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/impersonation",
      headers: authHeader(token),
      payload: { targetUserId: TARGET_USER_APP_ID, mode: "delegation", reason: VALID_REASON },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({
      type: "https://httpproblems.com/http-status/401",
      title: "Unauthorized",
      status: 401,
      reason: "acr_insufficient",
      step_up_required: true,
    });
  });

  it("acr=2 but auth_time stale → 401 with reason=auth_time_stale + step_up_required=true", async () => {
    const token = superAdminToken({ acr: "2", auth_time: Math.floor(Date.now() / 1000) - 600 });
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/impersonation",
      headers: authHeader(token),
      payload: { targetUserId: TARGET_USER_APP_ID, mode: "delegation", reason: VALID_REASON },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({
      reason: "auth_time_stale",
      step_up_required: true,
    });
  });

  it("missing auth_time → 401 with reason=no_auth_time", async () => {
    const token = superAdminToken({ acr: "2", auth_time: undefined });
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/impersonation",
      headers: authHeader(token),
      payload: { targetUserId: TARGET_USER_APP_ID, mode: "delegation", reason: VALID_REASON },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({
      reason: "no_auth_time",
      step_up_required: true,
    });
  });

  it("acr=2 + fresh auth_time → 201 (happy path)", async () => {
    const token = superAdminToken({ acr: "2", auth_time: Math.floor(Date.now() / 1000) - 30 });
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/impersonation",
      headers: authHeader(token),
      payload: { targetUserId: TARGET_USER_APP_ID, mode: "delegation", reason: VALID_REASON },
    });
    expect(res.statusCode).toBe(201);
  });

  // KC emits `acr` as `["2"]` in some broker configs; `normaliseAcr` in
  // the auth plugin handles both shapes (issue #24 review H2). Locking
  // the array variant here so a future refactor that drops the array
  // branch doesn't silently break broker-mediated logins.
  it('acr=["2"] (broker array variant) + fresh auth_time → 201', async () => {
    const token = superAdminToken({ acr: ["2"], auth_time: Math.floor(Date.now() / 1000) - 30 });
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/impersonation",
      headers: authHeader(token),
      payload: { targetUserId: TARGET_USER_APP_ID, mode: "delegation", reason: VALID_REASON },
    });
    expect(res.statusCode).toBe(201);
  });

  it("step-up failure that triggers lockout → 401 with step_up_required=false (no redirect loop)", async () => {
    // Pre-seed the counter to N-1 so the next failure flips the lockout.
    await redis.set(
      `impersonation:denied:${SUPER_ADMIN_KEYCLOAK_ID}`,
      String(IMPERSONATION_DENIED_LOCKOUT_THRESHOLD - 1),
      "EX",
      15 * 60,
    );
    const token = superAdminToken({ acr: "1", auth_time: Math.floor(Date.now() / 1000) - 30 });
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/impersonation",
      headers: authHeader(token),
      payload: { targetUserId: TARGET_USER_APP_ID, mode: "delegation", reason: VALID_REASON },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({
      reason: "acr_insufficient",
      step_up_required: false,
    });
  });
});

// ─── Token claim shape (review QA F12 / F13) ───────────────────────────────

describe("Issued JWT shape", () => {
  function decodePayload(token: string): Record<string, unknown> {
    const parts = token.split(".");
    return JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
  }

  it("delegation token retains `super_admin` realm role", async () => {
    const operator = superAdminToken();
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/impersonation",
      headers: authHeader(operator),
      payload: { targetUserId: TARGET_USER_APP_ID, mode: "delegation", reason: VALID_REASON },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    const payload = decodePayload(body.data.token);
    const realmRoles =
      (payload as { realm_access?: { roles?: string[] } }).realm_access?.roles ?? [];
    expect(realmRoles).toContain("super_admin");
  });

  it("pure-impersonation token strips `super_admin` and uses target role only", async () => {
    const operator = superAdminToken();
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/impersonation",
      headers: authHeader(operator),
      payload: { targetUserId: TARGET_USER_APP_ID, mode: "impersonation", reason: VALID_REASON },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    const payload = decodePayload(body.data.token);
    const realmRoles =
      (payload as { realm_access?: { roles?: string[] } }).realm_access?.roles ?? [];
    expect(realmRoles).not.toContain("super_admin");
    expect(realmRoles).toContain("org_admin"); // target's role
  });

  it("both modes carry `act.sub === operator` (RFC 8693 — review F13)", async () => {
    const operator = superAdminToken();
    for (const mode of ["delegation", "impersonation"] as const) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/admin/impersonation",
        headers: authHeader(operator),
        payload: { targetUserId: TARGET_USER_APP_ID, mode, reason: VALID_REASON },
      });
      expect(res.statusCode).toBe(201);
      const payload = decodePayload(JSON.parse(res.payload).data.token) as {
        act?: { sub?: string };
        sub?: string;
        imp_mode?: string;
      };
      expect(payload.act?.sub).toBe(SUPER_ADMIN_KEYCLOAK_ID);
      expect(payload.sub).toBe(TARGET_USER_KEYCLOAK_ID);
      expect(payload.imp_mode).toBe(mode);
    }
  });
});

// ─── Cross-tenant RLS isolation (review QA F2) ─────────────────────────────

describe("Cross-tenant RLS isolation", () => {
  it("pure-impersonation session in ORG_A cannot see ORG_B resources", async () => {
    // Insert an ORG_B-owned constituent that the impersonator should NOT
    // be able to see, even though they have super_admin.
    await db.execute(sql`
      INSERT INTO constituents (id, org_id, first_name, last_name, type)
      VALUES ('00000000-0000-0000-0000-000000000bb1', ${ORG_B}, 'OrgB', 'Constituent', 'donor')
      ON CONFLICT (id) DO NOTHING
    `);

    const operator = superAdminToken();
    const start = await app.inject({
      method: "POST",
      url: "/v1/admin/impersonation",
      headers: authHeader(operator),
      payload: { targetUserId: TARGET_USER_APP_ID, mode: "impersonation", reason: VALID_REASON },
    });
    expect(start.statusCode).toBe(201);
    const cookie = extractImpersonationCookie(start.headers["set-cookie"]) ?? "";

    // Attempt to read the ORG_B-owned constituent from inside the ORG_A
    // impersonation session — RLS must shadow it as 404.
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents/00000000-0000-0000-0000-000000000bb1",
      headers: { cookie: `givernance_jwt=${cookie}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ─── List endpoint ─────────────────────────────────────────────────────────

describe("GET /v1/admin/impersonation", () => {
  it("returns active sessions only by default", async () => {
    const token = superAdminToken();
    await app.inject({
      method: "POST",
      url: "/v1/admin/impersonation",
      headers: authHeader(token),
      payload: { targetUserId: TARGET_USER_APP_ID, mode: "delegation", reason: VALID_REASON },
    });

    const list = await app.inject({
      method: "GET",
      url: "/v1/admin/impersonation",
      headers: authHeader(token),
    });
    expect(list.statusCode).toBe(200);
    const body = JSON.parse(list.payload);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0]).toMatchObject({ isActive: true });
  });
});

// Non-test cleanup. impersonation_sessions is append-only at the DB level
// (trigger from migration 0033) — the most we can do is mark the rows
// ended. audit_logs rows referencing these sessions are also immutable so
// the suite's footprint is permanent in the test DB; that's fine — the
// table is platform-scoped and only contains synthetic test data here.
afterAll(async () => {
  await db.execute(
    sql`UPDATE impersonation_sessions SET ended_at = COALESCE(ended_at, NOW()), end_reason = COALESCE(end_reason, 'manual') WHERE ended_at IS NULL`,
  );
  // Keep ORG_A / ORG_B / USER_A / USER_B since other suites depend on them.
  // Cannot DELETE the target users either, because audit_logs reference
  // them by keycloak_id and the audit_logs trigger blocks DELETE on
  // related rows via FK semantics indirectly.
  void ORG_B;
  void USER_A;
  void USER_B;
});
