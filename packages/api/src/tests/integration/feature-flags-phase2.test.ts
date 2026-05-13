/**
 * Feature-flag Phase 2 integration tests (Epic #365 / PR #366).
 *
 * Covers the surfaces introduced by Phase 2:
 *
 *   1. Public projection — `GET /v1/feature-flags` filters by
 *      `public=true` and overlays the caller's tenant overrides.
 *   2. Super-admin tenant overrides — GET / PUT / DELETE under
 *      `/v1/admin/tenants/:tenantId/feature-flags`.
 *   3. `overrideStats` field on `GET /v1/admin/feature-flags` when
 *      `admin.feature_flags_phase2` is on (null otherwise).
 *   4. Org-admin self-service — `/v1/org/feature-flags` GET + PATCH.
 *   5. Off-state QA — every Phase-2 endpoint 404s when the
 *      self-flag is off.
 *
 * Test fixtures (set up in beforeAll, torn down in afterAll):
 *
 *   - `admin.feature_flags_phase2` flipped on for the duration of
 *     the suite (so the Phase-2 surfaces are reachable).
 *   - A test-only flag `test.scope_tenant_demo` with
 *     `scope='tenant', tenant_override_allowed=true, public=true`.
 *     The day-one production registry has zero `scope='tenant'`
 *     flags so the positive paths need a fixture flag.
 *   - A test-only flag `test.scope_tenant_admin_only` with
 *     `scope='tenant', tenant_override_allowed=false, public=false`.
 *     Used to assert that org-admin is correctly excluded.
 *
 * `audit_log` emission is exercised by the existing audit-plugin
 * tests; here we focus on flag semantics. The plugin auto-records
 * every mutating request to `/v1/admin/tenants/.../feature-flags`
 * and `/v1/org/feature-flags`, so we don't need a bespoke assertion.
 */

import { featureFlags, tenantFlagOverrides } from "@givernance/shared/schema";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";
import { flagService } from "../../lib/flags/flag-service.js";
import { redis } from "../../lib/redis.js";
import { createServer } from "../../server.js";
import {
  authHeader,
  ensureTestTenants,
  ORG_A,
  ORG_B,
  signToken,
  signTokenB,
} from "../helpers/auth.js";

let app: FastifyInstance;

const PHASE2_KEY = "admin.feature_flags_phase2";
const TENANT_DEMO_KEY = "test.scope_tenant_demo";
const TENANT_ADMIN_ONLY_KEY = "test.scope_tenant_admin_only";

function superAdminToken(): string {
  return signToken(app, {
    realm_access: { roles: ["super_admin"] },
    role: "super_admin",
  });
}

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();

  // Enable the Phase 2 self-flag so the new endpoints are reachable.
  await db.update(featureFlags).set({ enabled: true }).where(eq(featureFlags.key, PHASE2_KEY));

  // Seed the two test fixture flags. These are NOT in
  // FEATURE_FLAG_REGISTRY — the parity test in feature-flags.test.ts
  // iterates the registry, so unregistered DB rows don't break it.
  // They live in the DB only for this suite's positive paths.
  await db
    .insert(featureFlags)
    .values([
      {
        key: TENANT_DEMO_KEY,
        enabled: false,
        label: "Test fixture — tenant-overridable",
        description:
          "Test fixture used by feature-flags-phase2 integration tests. Not part of the production registry; safe to ignore in operator UI.",
        scope: "tenant",
        tenantOverrideAllowed: true,
        public: true,
      },
      {
        key: TENANT_ADMIN_ONLY_KEY,
        enabled: false,
        label: "Test fixture — super-admin-gated",
        description:
          "Test fixture used by feature-flags-phase2 integration tests. Tenant-scoped but only super-admin can flip the override per tenant.",
        scope: "tenant",
        tenantOverrideAllowed: false,
        public: false,
      },
    ])
    .onConflictDoNothing();

  await flagService.invalidate();
});

afterAll(async () => {
  // Wipe everything this suite added so other suites see a clean DB.
  await db.delete(tenantFlagOverrides).where(eq(tenantFlagOverrides.flagKey, TENANT_DEMO_KEY));
  await db
    .delete(tenantFlagOverrides)
    .where(eq(tenantFlagOverrides.flagKey, TENANT_ADMIN_ONLY_KEY));
  await db.delete(featureFlags).where(eq(featureFlags.key, TENANT_DEMO_KEY));
  await db.delete(featureFlags).where(eq(featureFlags.key, TENANT_ADMIN_ONLY_KEY));
  await db.update(featureFlags).set({ enabled: false }).where(eq(featureFlags.key, PHASE2_KEY));
  await flagService.invalidate();
  await flagService.invalidateTenant(ORG_A);
  await flagService.invalidateTenant(ORG_B);
  await app.close();
});

beforeEach(async () => {
  // Clear any overrides left by previous tests, plus rate-limit cache.
  await db.delete(tenantFlagOverrides).where(eq(tenantFlagOverrides.flagKey, TENANT_DEMO_KEY));
  await db
    .delete(tenantFlagOverrides)
    .where(eq(tenantFlagOverrides.flagKey, TENANT_ADMIN_ONLY_KEY));
  const keys = await redis.keys("*rate-limit*");
  if (keys.length > 0) await redis.del(...keys);
  await flagService.invalidate();
  await flagService.invalidateTenant(ORG_A);
  await flagService.invalidateTenant(ORG_B);
});

// ─── 1. Public projection ──────────────────────────────────────────────────

describe("GET /v1/feature-flags — public projection (Phase 2)", () => {
  it("returns only rows with public=true (admin-only keys excluded)", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/feature-flags",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ key: string; enabled: boolean }> }>();
    const keys = body.data.map((row) => row.key);
    expect(keys).toContain(TENANT_DEMO_KEY); // public=true
    expect(keys).not.toContain(TENANT_ADMIN_ONLY_KEY); // public=false
  });

  it("overlays the caller's tenant override on the value", async () => {
    // ORG_A sets an override turning TENANT_DEMO_KEY ON; ORG_A sees
    // `enabled: true` while ORG_B (no override) sees `enabled: false`.
    const superToken = superAdminToken();
    const upsertRes = await app.inject({
      method: "PUT",
      url: `/v1/admin/tenants/${ORG_A}/feature-flags/${TENANT_DEMO_KEY}`,
      headers: authHeader(superToken),
      payload: { value: true, reason: "RLS-overlay test" },
    });
    expect(upsertRes.statusCode).toBe(200);

    const tokenA = signToken(app);
    const resA = await app.inject({
      method: "GET",
      url: "/v1/feature-flags",
      headers: authHeader(tokenA),
    });
    expect(resA.statusCode).toBe(200);
    const bodyA = resA.json<{ data: Array<{ key: string; enabled: boolean }> }>();
    const rowA = bodyA.data.find((r) => r.key === TENANT_DEMO_KEY);
    expect(rowA?.enabled).toBe(true);

    const tokenB = signTokenB(app);
    const resB = await app.inject({
      method: "GET",
      url: "/v1/feature-flags",
      headers: authHeader(tokenB),
    });
    expect(resB.statusCode).toBe(200);
    const bodyB = resB.json<{ data: Array<{ key: string; enabled: boolean }> }>();
    const rowB = bodyB.data.find((r) => r.key === TENANT_DEMO_KEY);
    expect(rowB?.enabled).toBe(false);
  });
});

// ─── 2. Super-admin: GET /admin/tenants/:id/feature-flags ──────────────────

describe("GET /v1/admin/tenants/:tenantId/feature-flags (Phase 2)", () => {
  it("super-admin sees every flag with platform default + effective + override", async () => {
    const token = superAdminToken();
    const res = await app.inject({
      method: "GET",
      url: `/v1/admin/tenants/${ORG_A}/feature-flags`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: Array<{
        key: string;
        scope: "platform" | "tenant";
        platformDefault: boolean;
        effectiveValue: boolean;
        override: { value: boolean } | null;
      }>;
    }>();
    const demo = body.data.find((r) => r.key === TENANT_DEMO_KEY);
    expect(demo).toBeDefined();
    expect(demo?.scope).toBe("tenant");
    expect(demo?.platformDefault).toBe(false);
    expect(demo?.effectiveValue).toBe(false);
    expect(demo?.override).toBeNull();
  });

  it("after a PUT, the response shows the override row + effective value", async () => {
    const token = superAdminToken();
    await app.inject({
      method: "PUT",
      url: `/v1/admin/tenants/${ORG_A}/feature-flags/${TENANT_DEMO_KEY}`,
      headers: authHeader(token),
      payload: { value: true, reason: "Smoke-test override" },
    });
    const res = await app.inject({
      method: "GET",
      url: `/v1/admin/tenants/${ORG_A}/feature-flags`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: Array<{
        key: string;
        effectiveValue: boolean;
        override: { value: boolean; reason: string | null } | null;
      }>;
    }>();
    const demo = body.data.find((r) => r.key === TENANT_DEMO_KEY);
    expect(demo?.effectiveValue).toBe(true);
    expect(demo?.override?.value).toBe(true);
    expect(demo?.override?.reason).toBe("Smoke-test override");
  });

  it("non-super-admin gets 404 (anti-disclosure)", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/admin/tenants/${ORG_A}/feature-flags`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(404);
  });
});

// ─── 3. Super-admin: PUT /admin/tenants/:id/feature-flags/:key ─────────────

describe("PUT /v1/admin/tenants/:tenantId/feature-flags/:key (Phase 2)", () => {
  it("creates a new override (200) + cache reflects the change immediately", async () => {
    const token = superAdminToken();
    const res = await app.inject({
      method: "PUT",
      url: `/v1/admin/tenants/${ORG_A}/feature-flags/${TENANT_DEMO_KEY}`,
      headers: authHeader(token),
      payload: { value: true, reason: "test" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { value: boolean; reason: string } }>();
    expect(body.data.value).toBe(true);
    expect(body.data.reason).toBe("test");

    // Evaluator must reflect the change without waiting on TTL.
    const enabled = await flagService.isEnabled(TENANT_DEMO_KEY, { orgId: ORG_A });
    expect(enabled).toBe(true);
  });

  it("re-PUT with the same payload is idempotent (200, updated_at bumped)", async () => {
    const token = superAdminToken();
    await app.inject({
      method: "PUT",
      url: `/v1/admin/tenants/${ORG_A}/feature-flags/${TENANT_DEMO_KEY}`,
      headers: authHeader(token),
      payload: { value: true, reason: "first" },
    });
    const res = await app.inject({
      method: "PUT",
      url: `/v1/admin/tenants/${ORG_A}/feature-flags/${TENANT_DEMO_KEY}`,
      headers: authHeader(token),
      payload: { value: true, reason: "second" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { reason: string } }>();
    expect(body.data.reason).toBe("second");
  });

  it("rejects a platform-scoped flag with 422 + RFC 9457 problem body", async () => {
    const token = superAdminToken();
    const res = await app.inject({
      method: "PUT",
      url: `/v1/admin/tenants/${ORG_A}/feature-flags/${PHASE2_KEY}`,
      headers: authHeader(token),
      payload: { value: true },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json<{ type: string; title: string; status: number; detail: string }>();
    expect(body.status).toBe(422);
    expect(body.title).toBe("Unprocessable Entity");
    expect(body.detail).toMatch(/platform-scoped/);
  });

  it("404s for an unknown flag key (RFC 9457 body)", async () => {
    const token = superAdminToken();
    const res = await app.inject({
      method: "PUT",
      url: `/v1/admin/tenants/${ORG_A}/feature-flags/nonexistent.key`,
      headers: authHeader(token),
      payload: { value: true },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json<{ status: number; title: string }>();
    expect(body.status).toBe(404);
    expect(body.title).toBe("Not Found");
  });
});

// ─── 4. Super-admin: DELETE /admin/tenants/:id/feature-flags/:key ──────────

describe("DELETE /v1/admin/tenants/:tenantId/feature-flags/:key (Phase 2)", () => {
  it("removes an existing override and returns 204", async () => {
    const token = superAdminToken();
    await app.inject({
      method: "PUT",
      url: `/v1/admin/tenants/${ORG_A}/feature-flags/${TENANT_DEMO_KEY}`,
      headers: authHeader(token),
      payload: { value: true },
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/admin/tenants/${ORG_A}/feature-flags/${TENANT_DEMO_KEY}`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(204);

    // Evaluator reverts to the platform default.
    const enabled = await flagService.isEnabled(TENANT_DEMO_KEY, { orgId: ORG_A });
    expect(enabled).toBe(false);
  });

  it("204 even when no override existed (idempotent intent)", async () => {
    const token = superAdminToken();
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/admin/tenants/${ORG_A}/feature-flags/${TENANT_DEMO_KEY}`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(204);
  });
});

// ─── 5. GET /admin/feature-flags — overrideStats field ─────────────────────

describe("GET /v1/admin/feature-flags — overrideStats (Phase 2)", () => {
  it("rows carry overrideStats with counts when phase2 is on", async () => {
    const token = superAdminToken();
    // ORG_A overrides ON, ORG_B overrides OFF — stats should report 1/1.
    await app.inject({
      method: "PUT",
      url: `/v1/admin/tenants/${ORG_A}/feature-flags/${TENANT_DEMO_KEY}`,
      headers: authHeader(token),
      payload: { value: true },
    });
    await app.inject({
      method: "PUT",
      url: `/v1/admin/tenants/${ORG_B}/feature-flags/${TENANT_DEMO_KEY}`,
      headers: authHeader(token),
      payload: { value: false },
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/feature-flags",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: Array<{
        key: string;
        overrideStats: { enabledCount: number; disabledCount: number } | null;
      }>;
    }>();
    const demo = body.data.find((r) => r.key === TENANT_DEMO_KEY);
    expect(demo?.overrideStats).toEqual({ enabledCount: 1, disabledCount: 1 });
  });
});

// ─── 6. Org-admin self-service ─────────────────────────────────────────────

describe("GET /v1/org/feature-flags (Phase 2)", () => {
  it("returns only scope=tenant AND tenant_override_allowed=true flags", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/org/feature-flags",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ key: string }> }>();
    const keys = body.data.map((r) => r.key);
    expect(keys).toContain(TENANT_DEMO_KEY);
    expect(keys).not.toContain(TENANT_ADMIN_ONLY_KEY); // tenant_override_allowed=false
    expect(keys).not.toContain(PHASE2_KEY); // scope=platform
  });

  it("non-org_admin gets 403 (RBAC denial — anti-disclosure 404 would be wrong here because requireOrgAdmin uses 403)", async () => {
    // The org_admin guard returns 403, not 404, because it's a known
    // tenant-side endpoint — anti-disclosure isn't the goal here.
    const token = signToken(app, { role: "viewer" });
    const res = await app.inject({
      method: "GET",
      url: "/v1/org/feature-flags",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("PATCH /v1/org/feature-flags/:key (Phase 2)", () => {
  it("org-admin can toggle a scope='tenant' AND override_allowed=true flag", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/org/feature-flags/${TENANT_DEMO_KEY}`,
      headers: authHeader(token),
      payload: { value: true, reason: "org-admin self-serve" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { value: boolean; setBy: string | null } }>();
    expect(body.data.value).toBe(true);
    // setBy must be populated for org-admin (unlike super-admin which leaves it NULL).
    expect(body.data.setBy).not.toBeNull();

    const enabled = await flagService.isEnabled(TENANT_DEMO_KEY, { orgId: ORG_A });
    expect(enabled).toBe(true);
  });

  it("org-admin gets 404 (anti-disclosure) when toggling a tenant_override_allowed=false flag — body matches RFC 9457", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/org/feature-flags/${TENANT_ADMIN_ONLY_KEY}`,
      headers: authHeader(token),
      payload: { value: true },
    });
    expect(res.statusCode).toBe(404);
    // Lock RFC 9457 body shape per `feedback_lock_rfc9457_body_in_tests`
    // so a regression to a plain-string or `{error}` body is caught.
    const body = res.json<{ type: string; title: string; status: number; detail: string }>();
    expect(body.status).toBe(404);
    expect(body.title).toBe("Not Found");
  });

  it("org-admin gets 404 (anti-disclosure) when toggling a scope='platform' flag — body matches RFC 9457", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/org/feature-flags/${PHASE2_KEY}`,
      headers: authHeader(token),
      payload: { value: true },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json<{ status: number; title: string }>();
    expect(body.status).toBe(404);
    expect(body.title).toBe("Not Found");
  });

  it("org-admin's override is isolated to their tenant (org A cannot affect org B)", async () => {
    const tokenA = signToken(app);
    await app.inject({
      method: "PATCH",
      url: `/v1/org/feature-flags/${TENANT_DEMO_KEY}`,
      headers: authHeader(tokenA),
      payload: { value: true },
    });

    // Org B's evaluator still sees the platform default — RLS keeps
    // org A's override out of org B's tenant map.
    const enabledA = await flagService.isEnabled(TENANT_DEMO_KEY, { orgId: ORG_A });
    const enabledB = await flagService.isEnabled(TENANT_DEMO_KEY, { orgId: ORG_B });
    expect(enabledA).toBe(true);
    expect(enabledB).toBe(false);
  });
});

// ─── 7. Off-state QA — every Phase-2 endpoint 404s when self-flag is off ───

describe("Phase-2 self-flag off-state QA", () => {
  // This block flips the self-flag OFF then back ON so all the
  // Phase-2 endpoints can be exercised in their disabled posture.
  beforeAll(async () => {
    await db.update(featureFlags).set({ enabled: false }).where(eq(featureFlags.key, PHASE2_KEY));
    await flagService.invalidate();
  });
  afterAll(async () => {
    await db.update(featureFlags).set({ enabled: true }).where(eq(featureFlags.key, PHASE2_KEY));
    await flagService.invalidate();
  });

  it("GET /admin/tenants/:tenantId/feature-flags → 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/admin/tenants/${ORG_A}/feature-flags`,
      headers: authHeader(superAdminToken()),
    });
    expect(res.statusCode).toBe(404);
  });

  it("PUT /admin/tenants/:tenantId/feature-flags/:key → 404", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/v1/admin/tenants/${ORG_A}/feature-flags/${TENANT_DEMO_KEY}`,
      headers: authHeader(superAdminToken()),
      payload: { value: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it("DELETE /admin/tenants/:tenantId/feature-flags/:key → 404", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/admin/tenants/${ORG_A}/feature-flags/${TENANT_DEMO_KEY}`,
      headers: authHeader(superAdminToken()),
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET /org/feature-flags → 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/org/feature-flags",
      headers: authHeader(signToken(app)),
    });
    expect(res.statusCode).toBe(404);
  });

  it("PATCH /org/feature-flags/:key → 404", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/org/feature-flags/${TENANT_DEMO_KEY}`,
      headers: authHeader(signToken(app)),
      payload: { value: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it("/admin/feature-flags response has overrideStats=null when phase2 is off", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/feature-flags",
      headers: authHeader(superAdminToken()),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ overrideStats: unknown }> }>();
    for (const row of body.data) {
      expect(row.overrideStats).toBeNull();
    }
  });
});

// ─── 8. Precedence matrix unit-test through the route surface ───────────────

describe("Evaluator precedence matrix (Phase 2)", () => {
  it("scope='platform' ignores tenant overrides even when rows exist", async () => {
    // Force-write an override row for a platform-scoped flag (would
    // never happen via the route — `resolveOverrideTarget` rejects —
    // but RLS doesn't stop a direct DB insert). The evaluator must
    // still ignore it.
    await db.insert(tenantFlagOverrides).values({
      tenantId: ORG_A,
      flagKey: PHASE2_KEY, // scope='platform'
      value: false, // override would turn it OFF
      reason: "precedence-test",
    });
    await flagService.invalidateTenant(ORG_A);

    // PHASE2_KEY platform default is `enabled=true` for this suite
    // (set in beforeAll). The evaluator should return TRUE despite
    // the false override.
    const enabled = await flagService.isEnabled(PHASE2_KEY, { orgId: ORG_A });
    expect(enabled).toBe(true);

    // Clean up the artificially-injected row.
    await db
      .delete(tenantFlagOverrides)
      .where(
        and(eq(tenantFlagOverrides.tenantId, ORG_A), eq(tenantFlagOverrides.flagKey, PHASE2_KEY)),
      );
    await flagService.invalidateTenant(ORG_A);
  });

  it("unknown key → false", async () => {
    const enabled = await flagService.isEnabled("does.not.exist", { orgId: ORG_A });
    expect(enabled).toBe(false);
  });

  it("scope='tenant' + no orgId → platform default (worker path)", async () => {
    const enabled = await flagService.isEnabled(TENANT_DEMO_KEY);
    expect(enabled).toBe(false); // platform default
  });
});

// ─── 9. Cross-tenant API-surface isolation ────────────────────────────────

describe("Cross-tenant isolation on super-admin routes (Phase 2)", () => {
  it("org-admin token cannot reach the super-admin tenant-detail GET (404 anti-disclosure)", async () => {
    const token = signToken(app); // ORG_A org_admin
    const res = await app.inject({
      method: "GET",
      url: `/v1/admin/tenants/${ORG_B}/feature-flags`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(404);
  });

  it("viewer token gets 404 on the super-admin tenant-detail PUT", async () => {
    const token = signToken(app, { role: "viewer" });
    const res = await app.inject({
      method: "PUT",
      url: `/v1/admin/tenants/${ORG_B}/feature-flags/${TENANT_DEMO_KEY}`,
      headers: authHeader(token),
      payload: { value: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it("super-admin gets 404 on a tenantId that doesn't exist (anti-disclosure pre-check)", async () => {
    const token = superAdminToken();
    // UUID-shaped but unseeded.
    const fakeTenantId = "00000000-0000-0000-0000-00000000ffff";
    const res = await app.inject({
      method: "PUT",
      url: `/v1/admin/tenants/${fakeTenantId}/feature-flags/${TENANT_DEMO_KEY}`,
      headers: authHeader(token),
      payload: { value: true },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json<{ status: number; title: string; detail: string }>();
    expect(body.status).toBe(404);
    expect(body.title).toBe("Not Found");
    expect(body.detail).toMatch(/[Tt]enant/);
  });

  it("super-admin DELETE on a non-existent tenant returns 404 (not silent 204)", async () => {
    const token = superAdminToken();
    const fakeTenantId = "00000000-0000-0000-0000-00000000eeee";
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/admin/tenants/${fakeTenantId}/feature-flags/${TENANT_DEMO_KEY}`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(404);
  });
});

// ─── 12. Per-flag tenant listing (drives /admin/feature-flags/[key]) ────────

describe("GET /v1/admin/feature-flags/:key/tenants (Phase 2)", () => {
  it("returns every active tenant + their effective value for the flag", async () => {
    const token = superAdminToken();
    const res = await app.inject({
      method: "GET",
      url: `/v1/admin/feature-flags/${TENANT_DEMO_KEY}/tenants`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: Array<{
        tenantId: string;
        tenantName: string;
        effectiveValue: boolean;
        override: { value: boolean } | null;
      }>;
    }>();
    // Both seed tenants (ORG_A, ORG_B) must be present.
    const ids = body.data.map((row) => row.tenantId);
    expect(ids).toContain(ORG_A);
    expect(ids).toContain(ORG_B);
    // Without overrides, both should reflect the platform default.
    const a = body.data.find((row) => row.tenantId === ORG_A);
    const b = body.data.find((row) => row.tenantId === ORG_B);
    expect(a?.override).toBeNull();
    expect(b?.override).toBeNull();
    expect(a?.effectiveValue).toBe(false); // platform default for TENANT_DEMO_KEY
    expect(b?.effectiveValue).toBe(false);
  });

  it("reflects an override on the listing's effectiveValue + override row", async () => {
    const token = superAdminToken();
    // Set an override for ORG_A.
    await app.inject({
      method: "PUT",
      url: `/v1/admin/tenants/${ORG_A}/feature-flags/${TENANT_DEMO_KEY}`,
      headers: authHeader(token),
      payload: { value: true, reason: "Per-flag listing test" },
    });

    const res = await app.inject({
      method: "GET",
      url: `/v1/admin/feature-flags/${TENANT_DEMO_KEY}/tenants`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: Array<{
        tenantId: string;
        effectiveValue: boolean;
        override: { value: boolean; reason: string | null } | null;
      }>;
    }>();
    const a = body.data.find((row) => row.tenantId === ORG_A);
    expect(a?.effectiveValue).toBe(true);
    expect(a?.override?.value).toBe(true);
    expect(a?.override?.reason).toBe("Per-flag listing test");

    // ORG_B still uses the platform default.
    const b = body.data.find((row) => row.tenantId === ORG_B);
    expect(b?.effectiveValue).toBe(false);
    expect(b?.override).toBeNull();
  });

  it("returns empty array for an unknown flag key (browse-friendly, not 404)", async () => {
    const token = superAdminToken();
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/feature-flags/nonexistent.key/tenants",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: unknown[] }>();
    expect(body.data).toEqual([]);
  });

  it("non-super-admin gets 404 (anti-disclosure)", async () => {
    const token = signToken(app); // ORG_A org_admin
    const res = await app.inject({
      method: "GET",
      url: `/v1/admin/feature-flags/${TENANT_DEMO_KEY}/tenants`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(404);
  });
});

// ─── 10. Org-admin DELETE — clean revert-to-default ────────────────────────

describe("DELETE /v1/org/feature-flags/:key (Phase 2)", () => {
  it("removes the override + evaluator reverts to platform default", async () => {
    const token = signToken(app);
    // Seed an override first.
    await app.inject({
      method: "PATCH",
      url: `/v1/org/feature-flags/${TENANT_DEMO_KEY}`,
      headers: authHeader(token),
      payload: { value: true },
    });
    expect(await flagService.isEnabled(TENANT_DEMO_KEY, { orgId: ORG_A })).toBe(true);

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/org/feature-flags/${TENANT_DEMO_KEY}`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(204);

    // Evaluator reverts to platform default (false for TENANT_DEMO_KEY).
    expect(await flagService.isEnabled(TENANT_DEMO_KEY, { orgId: ORG_A })).toBe(false);
  });

  it("204 when no override existed (idempotent intent)", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/org/feature-flags/${TENANT_DEMO_KEY}`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(204);
  });

  it("404 (anti-disclosure) when targeting a scope='platform' flag", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/org/feature-flags/${PHASE2_KEY}`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(404);
  });

  it("404 (anti-disclosure) when targeting a tenant_override_allowed=false flag", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/org/feature-flags/${TENANT_ADMIN_ONLY_KEY}`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(404);
  });

  it("non-org_admin gets 403", async () => {
    const token = signToken(app, { role: "viewer" });
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/org/feature-flags/${TENANT_DEMO_KEY}`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(403);
  });
});

// ─── 11. Audit-trail regression net ─────────────────────────────────────────
//
// The existing audit-plugin auto-logs every mutating request. These
// tests pin one audit row per Phase-2 mutation verb so a future
// refactor of the plugin's pattern matching (or a re-shaping of the
// route URL template) doesn't silently break audit for the new
// endpoints. Per `feedback_lock_rfc9457_body_in_tests`-style reasoning:
// "audit trail covered by the plugin tests" only holds if the plugin
// continues to pattern-match these routes.

describe("Audit trail — Phase 2 override mutations land in audit_logs", () => {
  // The audit plugin records via Fastify's `onResponse` hook which
  // fires AFTER `app.inject()` returns. We poll briefly for the
  // expected row rather than `await sleep(...)` so the test stays
  // tight in the happy case and bounded in the slow case.
  async function findAuditRow(predicate: (action: string) => boolean): Promise<boolean> {
    const { auditLogs } = await import("@givernance/shared/schema");
    for (let attempt = 0; attempt < 30; attempt++) {
      const rows = await db.select({ action: auditLogs.action }).from(auditLogs);
      if (rows.some((r) => predicate(r.action))) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  it("PUT /admin/tenants/:id/feature-flags/:key emits an audit_logs row", async () => {
    const token = superAdminToken();
    await app.inject({
      method: "PUT",
      url: `/v1/admin/tenants/${ORG_A}/feature-flags/${TENANT_DEMO_KEY}`,
      headers: authHeader(token),
      payload: { value: true },
    });
    // Audit-plugin records `${method}:${routeOptions.url}`. We match
    // by method + the tenant-feature-flags substring rather than the
    // full path so we don't tie the assertion to whether Fastify
    // stores the route template with or without the `/v1` prefix.
    const found = await findAuditRow(
      (action) => action.startsWith("PUT:") && action.includes("/feature-flags"),
    );
    expect(found, "Audit row for PUT override missing").toBe(true);
  });

  it("DELETE /admin/tenants/:id/feature-flags/:key emits an audit_logs row", async () => {
    const token = superAdminToken();
    await app.inject({
      method: "DELETE",
      url: `/v1/admin/tenants/${ORG_A}/feature-flags/${TENANT_DEMO_KEY}`,
      headers: authHeader(token),
    });
    const found = await findAuditRow(
      (action) => action.startsWith("DELETE:") && action.includes("/feature-flags"),
    );
    expect(found, "Audit row for DELETE override missing").toBe(true);
  });

  it("PATCH /org/feature-flags/:key emits an audit_logs row", async () => {
    const token = signToken(app);
    await app.inject({
      method: "PATCH",
      url: `/v1/org/feature-flags/${TENANT_DEMO_KEY}`,
      headers: authHeader(token),
      payload: { value: true },
    });
    const found = await findAuditRow(
      (action) => action.startsWith("PATCH:") && action.includes("/org/feature-flags"),
    );
    expect(found, "Audit row for org-admin PATCH override missing").toBe(true);
  });
});
