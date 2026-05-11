/**
 * Feature-flag registry integration tests (issue #326 / PR #352 follow-up).
 *
 * Three surfaces covered:
 *   1. Admin API (`/v1/admin/feature-flags`) — super-admin GET + PATCH.
 *   2. Tenant-readable API (`/v1/feature-flags`) — any authenticated
 *      caller gets `{key, enabled}` rows.
 *   3. The `requireFlag` gate — POST /v1/constituents/bulk-email is
 *      404 when the flag is off, 401/202/etc. when it's on (the
 *      route's other preHandlers still run).
 *
 * The bulk-email flag is seeded `enabled = false` by migration
 * 0047_feature_flags. Tests that need it on flip via the admin PATCH
 * (verifying the cache invalidation works end-to-end) AND reset it in
 * `afterAll` so they don't pollute the cross-suite test DB.
 */

import { featureFlags } from "@givernance/shared/schema";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";
import { flagService } from "../../lib/flags/flag-service.js";
import { redis } from "../../lib/redis.js";
import { createServer } from "../../server.js";
import { authHeader, ensureTestTenants, ORG_A, signToken } from "../helpers/auth.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();
});

afterAll(async () => {
  // Belt-and-braces: leave the bulk-email flag in its seed state so
  // subsequent suites that share the test DB see a deterministic
  // starting point.
  await db
    .update(featureFlags)
    .set({ enabled: false })
    .where(eq(featureFlags.key, "communication.bulk_email"));
  await flagService.invalidate();
  await app.close();
});

beforeEach(async () => {
  // Reset rate-limit + flag cache between tests so a flip in one test
  // doesn't bleed into the next.
  const keys = await redis.keys("*rate-limit*");
  if (keys.length > 0) await redis.del(...keys);
  await flagService.invalidate();
});

afterEach(async () => {
  await db
    .update(featureFlags)
    .set({ enabled: false })
    .where(eq(featureFlags.key, "communication.bulk_email"));
  await flagService.invalidate();
});

describe("Admin feature-flag registry — GET /v1/admin/feature-flags", () => {
  it("super-admin lists every registered flag (description included)", async () => {
    const token = signToken(app, { realm_access: { roles: ["super_admin"] } });
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/feature-flags",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: Array<{ key: string; enabled: boolean; description: string }>;
    }>();
    const bulkEmail = body.data.find((row) => row.key === "communication.bulk_email");
    expect(bulkEmail).toBeDefined();
    expect(bulkEmail?.enabled).toBe(false);
    expect(bulkEmail?.description.length).toBeGreaterThan(0);
  });

  it("non-super-admin gets 404 (anti-disclosure, not 403)", async () => {
    const token = signToken(app); // default = org_admin, no super_admin
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/feature-flags",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(404);
  });

  it("unauthenticated GET is 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/feature-flags",
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("Admin feature-flag registry — PATCH /v1/admin/feature-flags/:key", () => {
  it("super-admin can flip the value AND the cache picks it up immediately", async () => {
    const token = signToken(app, { realm_access: { roles: ["super_admin"] } });

    // Pre-flight: confirm the flag starts disabled.
    expect(await flagService.isEnabled("communication.bulk_email")).toBe(false);

    const res = await app.inject({
      method: "PATCH",
      url: "/v1/admin/feature-flags/communication.bulk_email",
      headers: authHeader(token),
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { enabled: boolean } }>().data.enabled).toBe(true);

    // Cache was invalidated by the route → next read should hit PG
    // and return the new value. (The PATCH handler explicitly calls
    // flagService.invalidate() after the DB write.)
    expect(await flagService.isEnabled("communication.bulk_email")).toBe(true);
  });

  it("unknown flag key returns 404", async () => {
    const token = signToken(app, { realm_access: { roles: ["super_admin"] } });
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/admin/feature-flags/does.not.exist",
      headers: authHeader(token),
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it("non-super-admin gets 404 (no information leak about the route)", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/admin/feature-flags/communication.bulk_email",
      headers: authHeader(token),
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("Tenant-readable feature-flag projection — GET /v1/feature-flags", () => {
  it("authenticated org_admin gets `{ key, enabled }` only (no description / metadata)", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/feature-flags",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<Record<string, unknown>> }>();
    const bulkEmail = body.data.find((row) => row.key === "communication.bulk_email");
    expect(bulkEmail).toBeDefined();
    expect(bulkEmail).toEqual({
      key: "communication.bulk_email",
      enabled: false,
    });
    // The public projection must NOT include the admin-only metadata.
    expect(bulkEmail).not.toHaveProperty("description");
    expect(bulkEmail).not.toHaveProperty("updatedBy");
    expect(bulkEmail).not.toHaveProperty("updatedAt");
  });

  it("unauthenticated request is 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/feature-flags",
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("requireFlag gate on /v1/constituents/bulk-email", () => {
  it("returns 404 when the flag is off (looks like a typo'd route)", async () => {
    // Flag is OFF by default in `beforeEach`.
    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents/bulk-email",
      headers: authHeader(token),
      payload: {
        constituentIds: ["00000000-0000-0000-0000-000000000aaa"],
        subject: "Hello",
        body: "Should not get through the gate.",
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ title: string }>().title).toBe("Not Found");
  });

  it("returns 404 from the flag gate BEFORE the RBAC gate runs", async () => {
    // Send a viewer token — the route's RBAC gate would have produced
    // 403, but the flag gate fires first and 404s. This is the
    // anti-disclosure posture: a scanner can't enumerate which gated
    // routes need which roles.
    const viewerToken = signToken(app, {
      role: "viewer",
      realm_access: { roles: ["app-viewer"] },
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents/bulk-email",
      headers: authHeader(viewerToken),
      payload: {
        constituentIds: ["00000000-0000-0000-0000-000000000aaa"],
        subject: "Hello",
        body: "Should not get through.",
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it("hands off to the existing route handler when the flag is ON", async () => {
    // Flip the flag on directly + invalidate cache.
    await db
      .update(featureFlags)
      .set({ enabled: true })
      .where(eq(featureFlags.key, "communication.bulk_email"));
    await flagService.invalidate();

    const token = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents/bulk-email",
      headers: authHeader(token),
      payload: {
        constituentIds: ["00000000-0000-0000-0000-000000000bad"],
        subject: "Hello",
        body: "Cross-tenant id — should reach the service and 400.",
      },
    });
    // Flag is on, RBAC passes (token is org_admin), so the request
    // reaches the service which rejects the bogus id with 400 — NOT
    // 404 (flag-gate) and NOT 403 (RBAC).
    expect(res.statusCode).toBe(400);
  });
});

describe("Feature flag CHECK against DB drift between schema + seed", () => {
  it("the seed migration inserted the canonical bulk-email row", async () => {
    const rows = await db.execute<{ key: string; enabled: boolean; description: string }>(sql`
      SELECT key, enabled, description
      FROM feature_flags
      WHERE key = 'communication.bulk_email'
    `);
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]?.description).toContain("DKIM");
  });

  it("Tenant A token can read the public projection — RLS isn't applied (flags are global)", async () => {
    // The registry table has no RLS by design — confirm that a tenant
    // user reading it doesn't get filtered to 0 rows. (Regression
    // guard: if someone later adds RLS, this test will catch it.)
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/feature-flags",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: unknown[] }>();
    expect(body.data.length).toBeGreaterThan(0);
    void ORG_A; // Imported for symmetry with other suites; no per-tenant assertion needed.
  });
});
