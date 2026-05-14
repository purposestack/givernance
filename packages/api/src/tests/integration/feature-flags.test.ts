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

import { FEATURE_FLAG_REGISTRY } from "@givernance/shared/constants";
import { auditLogs, featureFlags } from "@givernance/shared/schema";
import { and, desc, eq, gte, sql } from "drizzle-orm";
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

  // PR #352 review QA-H1: 401 on unauthenticated PATCH — mirrors the
  // existing 401 case on the admin GET so the auth boundary is locked
  // in both directions of the verb space.
  it("unauthenticated PATCH is 401", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/admin/feature-flags/communication.bulk_email",
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(401);
  });

  // PR #352 review Log-H1: every super-admin flag flip MUST land in
  // `audit_logs`. The Log Analyst's first read suggested super-admins
  // had no `org_id` claim → silently skipped — that's false:
  // `verifyKeycloakJwt` rejects tokens without an `org_id`, so the
  // audit plugin always sees one. The row IS written; this test
  // pins that. Cleaner platform-scoped routing (audit rows under the
  // `__platform__` sentinel) is a separate follow-up — see doc 18 §0.
  it("super-admin flip is recorded in audit_logs", async () => {
    const before = new Date();
    const token = signToken(app, { realm_access: { roles: ["super_admin"] } });

    const res = await app.inject({
      method: "PATCH",
      url: "/v1/admin/feature-flags/communication.bulk_email",
      headers: authHeader(token),
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(200);

    // Poll for the audit row — the plugin's `onResponse` hook fires
    // after `inject` resolves, so a direct SELECT can race the insert.
    // Same pattern as `issue-56-hardening.test.ts:awaitAuditRow`.
    const deadline = Date.now() + 2000;
    let auditRow: { action: string; orgId: string; userId: string | null } | undefined;
    while (Date.now() < deadline) {
      const [r] = await db
        .select({
          action: auditLogs.action,
          orgId: auditLogs.orgId,
          userId: auditLogs.userId,
        })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.action, "PATCH:/v1/admin/feature-flags/:key"),
            gte(auditLogs.createdAt, before),
          ),
        )
        .orderBy(desc(auditLogs.createdAt))
        .limit(1);
      if (r) {
        auditRow = r;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(auditRow).toBeDefined();
    expect(auditRow?.action).toBe("PATCH:/v1/admin/feature-flags/:key");
    expect(auditRow?.userId).toBeTruthy();
    expect(auditRow?.orgId).toBeTruthy();
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
  // PR #352 review QA-H2: parametrise the 404 over all four gated
  // routes so a refactor that drops `requireFlag` from any one of
  // them is caught here, not in production.
  //
  // Payloads on the POSTs must satisfy the body validator
  // (`preValidation` runs BEFORE `preHandler` — an invalid body
  // 400s before the flag gate fires, hiding the regression we
  // want to catch).
  type GatedRoute = {
    method: "GET" | "POST";
    url: string;
    payload?: Record<string, unknown>;
  };
  const gatedRoutes: GatedRoute[] = [
    {
      method: "POST",
      url: "/v1/constituents/bulk-email",
      payload: {
        constituentIds: ["00000000-0000-0000-0000-000000000aaa"],
        subject: "x",
        body: "x",
      },
    },
    {
      method: "GET",
      url: "/v1/constituents/bulk-email-jobs",
    },
    {
      method: "GET",
      url: "/v1/constituents/bulk-email-jobs/00000000-0000-0000-0000-000000000aaa",
    },
    {
      method: "POST",
      url: "/v1/constituents/bulk-email-jobs/00000000-0000-0000-0000-000000000aaa/resume",
      payload: {},
    },
  ];

  for (const route of gatedRoutes) {
    it(`returns 404 on ${route.method} ${route.url} when the flag is off`, async () => {
      const token = signToken(app);
      const res = await app.inject({
        method: route.method,
        url: route.url,
        headers: authHeader(token),
        payload: route.payload,
      });
      expect(res.statusCode).toBe(404);
    });

    // PR #352 review Sec-M2: an unauthenticated scanner enumerating
    // gated routes must NOT get 401 (which would disclose route
    // existence) — must look identical to a typo'd URL.
    it(`unauthenticated ${route.method} ${route.url} also returns 404 (anti-disclosure)`, async () => {
      const res = await app.inject({
        method: route.method,
        url: route.url,
        payload: route.payload,
      });
      // Auth plugin returns 401 only when the route runs requireAuth
      // BEFORE the flag check. requireFlag runs first, so the
      // unauthenticated caller hits the gate 404. Accept either 404
      // (gate fires first) or 401 (auth fires first) — confirm
      // ANY 4xx response is `not 200, not 5xx`.
      expect(res.statusCode).toBe(404);
    });
  }

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
    const rows = await db.execute<{
      key: string;
      enabled: boolean;
      label: string;
      description: string;
    }>(sql`
      SELECT key, enabled, label, description
      FROM feature_flags
      WHERE key = 'communication.bulk_email'
    `);
    expect(rows.rows.length).toBe(1);
    const seeded = rows.rows[0]!;
    // Operator-facing text is plain language — no engineering jargon.
    // Pin the friendly label as a regression net against someone
    // pasting RFC references / issue IDs back into the seed.
    expect(seeded.label).toBe("Bulk emails to constituents");
    expect(seeded.description.toLowerCase()).not.toContain("dkim");
    expect(seeded.description.toLowerCase()).not.toContain("issue #");
  });

  // PR #352 review Plat-M3 (extended after the magino UX review):
  // the code-side `FEATURE_FLAG_REGISTRY` and the DB-side seed are
  // two halves of the same source-of-truth. Editing one and forgetting
  // the other leaves the Back Office UI with a label/description that
  // doesn't match a fresh-DB seed. This test catches the drift in CI.
  it("FEATURE_FLAG_REGISTRY matches the seeded DB rows (label + description + scope + tenant_override_allowed + public parity)", async () => {
    // PR #386 Plat-IMPORTANT (Epic #362 spike review): the prior parity
    // assertion only covered label + description, leaving scope /
    // tenant_override_allowed / public uncovered. Migration headers
    // (0051, 0053, …) and `docs/18-feature-flags.md` § 0 promise CI
    // catches drift on those three columns — extending the assertion
    // closes the gap so the next flag we add doesn't quietly ship with
    // the wrong scope or public-projection bit.
    for (const entry of FEATURE_FLAG_REGISTRY) {
      const [dbRow] = await db
        .select({
          label: featureFlags.label,
          description: featureFlags.description,
          scope: featureFlags.scope,
          tenantOverrideAllowed: featureFlags.tenantOverrideAllowed,
          public: featureFlags.public,
        })
        .from(featureFlags)
        .where(eq(featureFlags.key, entry.key));
      expect(dbRow, `Missing seed row for ${entry.key}`).toBeDefined();
      expect(dbRow?.label, `Label drift for ${entry.key}`).toBe(entry.label);
      expect(dbRow?.description, `Description drift for ${entry.key}`).toBe(entry.description);
      expect(dbRow?.scope, `Scope drift for ${entry.key}`).toBe(entry.scope);
      expect(dbRow?.tenantOverrideAllowed, `tenantOverrideAllowed drift for ${entry.key}`).toBe(
        entry.tenantOverrideAllowed,
      );
      expect(dbRow?.public, `public-projection drift for ${entry.key}`).toBe(entry.public);
    }
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
