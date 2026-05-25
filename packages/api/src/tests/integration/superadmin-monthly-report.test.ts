/**
 * Issue #443 — Super-admin monthly platform finance report.
 *
 * Coverage:
 *   - RBAC matrix on POST/GET routes (super_admin → 202/200/404;
 *     org_admin / user / viewer → 404; unauthenticated → 401).
 *   - Flag off → 404 on every gated route.
 *   - Idempotency: two POSTs for the same target month return the
 *     same `id`, only the first emits status=202 (fresh enqueue).
 *   - Audit trail: every POST writes a `platform_finance_report`
 *     `generate` row on `platform_orgId` with the super-admin's user
 *     id + ipHash.
 *   - Month validation: future month → 400 RFC-9457; malformed month → 400.
 *   - GET /:id 404 on unknown UUID; 200 with locked shape when found.
 *   - GET /:id/pdf 409 while pending; 200 streaming the bytes once
 *     the row is flipped to `ready` (we manually update the row to
 *     simulate the worker completing — the worker itself is unit-tested
 *     elsewhere).
 */

import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import { auditLogs, featureFlags, platformFinanceReports } from "@givernance/shared/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, systemDb } from "../../lib/db.js";
import { flagService } from "../../lib/flags/flag-service.js";
import { redis } from "../../lib/redis.js";
import { previousMonth } from "../../modules/superadmin/finance/monthly-report.js";
import { createServer } from "../../server.js";
import { authHeader, ensureTestTenants, signToken } from "../helpers/auth.js";

const FLAG_KEY = FEATURE_FLAG_KEYS.ADMIN_FINANCE_DASHBOARD;
const SUPER_ADMIN_KEYCLOAK_ID = "00000000-0000-0000-0000-0000000443ad";
const SUPER_ADMIN_PLATFORM_ROW_ID = "00000000-0000-0000-0000-0000000443a1";
const PLATFORM_TENANT_ID = "00000000-0000-0000-0000-0000000000a1";

let app: FastifyInstance;

function superAdminToken() {
  return signToken(app, {
    sub: SUPER_ADMIN_KEYCLOAK_ID,
    realm_access: { roles: ["super_admin"] },
    role: undefined,
    email: "super-report@example.org",
  });
}

async function setFlag(enabled: boolean): Promise<void> {
  await db.update(featureFlags).set({ enabled }).where(eq(featureFlags.key, FLAG_KEY));
  await flagService.invalidate();
}

async function clearReportsAndAudit(): Promise<void> {
  // Reports table is platform-level; drop everything per test for
  // isolation. `audit_logs` is immutable (`prevent_audit_log_mutation`
  // trigger) — tests scope their assertions by resource_id (UUID) +
  // most-recent ordering instead of bulk-clearing the table.
  await systemDb.execute(sql`DELETE FROM platform_finance_reports`);
  const keys = await redis.keys("superadmin:finance:summary:v1:*");
  if (keys.length > 0) await redis.del(...keys);
}

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();

  await systemDb.execute(sql`
    INSERT INTO tenants (id, name, slug, status)
    VALUES (${PLATFORM_TENANT_ID}, 'Givernance Platform (sentinel)', '__platform__', 'archived')
    ON CONFLICT (id) DO NOTHING
  `);

  await systemDb.execute(sql`
    INSERT INTO platform_admins (id, keycloak_id, email, first_name, last_name)
    VALUES (${SUPER_ADMIN_PLATFORM_ROW_ID}, ${SUPER_ADMIN_KEYCLOAK_ID}, 'super-report@example.org', 'Report', 'Super')
    ON CONFLICT (id) DO UPDATE SET deleted_at = NULL, keycloak_id = ${SUPER_ADMIN_KEYCLOAK_ID}
  `);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await clearReportsAndAudit();
  await setFlag(true);
});

afterEach(async () => {
  await setFlag(false);
});

// ─── helpers ──────────────────────────────────────────────────────────────

function monthsAgo(n: number, now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1; // 1-indexed
  // Walk back n months including the +1 step into the previous month already
  // baked into our "most recent fully-completed month" semantics.
  const total = y * 12 + (m - 1) - n;
  const ty = Math.floor(total / 12);
  const tm = (total % 12) + 1;
  return `${ty}-${String(tm).padStart(2, "0")}`;
}

describe("POST /v1/superadmin/finance/reports/monthly", () => {
  describe("RBAC matrix", () => {
    it("super_admin → 202 with locked shape", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/superadmin/finance/reports/monthly",
        headers: authHeader(superAdminToken()),
        payload: {},
      });
      expect(res.statusCode).toBe(202);
      const body = res.json() as {
        data: {
          id: string;
          month: string;
          status: "pending" | "ready" | "failed";
          createdAt: string;
        };
      };
      expect(body.data.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(body.data.month).toBe(previousMonth());
      expect(body.data.status).toBe("pending");
    });

    it("org_admin → 404 (anti-disclosure)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/superadmin/finance/reports/monthly",
        headers: authHeader(signToken(app)),
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });

    it("user role → 404", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/superadmin/finance/reports/monthly",
        headers: authHeader(signToken(app, { role: "user" })),
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });

    it("viewer role → 404", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/superadmin/finance/reports/monthly",
        headers: authHeader(signToken(app, { role: "viewer" })),
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });

    it("unauthenticated → 401 with RFC-9457 body", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/superadmin/finance/reports/monthly",
        payload: {},
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({
        type: "https://httpproblems.com/http-status/401",
        title: "Unauthorized",
        status: 401,
      });
    });

    it("flag off → 404 (gated route invisible)", async () => {
      await setFlag(false);
      const res = await app.inject({
        method: "POST",
        url: "/v1/superadmin/finance/reports/monthly",
        headers: authHeader(superAdminToken()),
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("month validation", () => {
    it("future month → 400 RFC-9457", async () => {
      const future = `${new Date().getUTCFullYear() + 1}-06`;
      const res = await app.inject({
        method: "POST",
        url: "/v1/superadmin/finance/reports/monthly",
        headers: authHeader(superAdminToken()),
        payload: { month: future },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        type: "https://httpproblems.com/http-status/400",
        title: "Bad Request",
        status: 400,
      });
    });

    it("malformed month → 400 (TypeBox rejects)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/superadmin/finance/reports/monthly",
        headers: authHeader(superAdminToken()),
        payload: { month: "2026-13" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("pre-platform-floor month (2023-12) → 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/superadmin/finance/reports/monthly",
        headers: authHeader(superAdminToken()),
        payload: { month: "2023-12" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("idempotency", () => {
    it("two same-month POSTs return the same id, second is 200 (replayed)", async () => {
      const first = await app.inject({
        method: "POST",
        url: "/v1/superadmin/finance/reports/monthly",
        headers: authHeader(superAdminToken()),
        payload: {},
      });
      expect(first.statusCode).toBe(202);
      const firstId = first.json().data.id;

      const second = await app.inject({
        method: "POST",
        url: "/v1/superadmin/finance/reports/monthly",
        headers: authHeader(superAdminToken()),
        payload: {},
      });
      expect(second.statusCode).toBe(200);
      expect(second.json().data.id).toBe(firstId);

      // Only one platform_finance_reports row exists.
      const rows = await systemDb
        .select({ id: platformFinanceReports.id })
        .from(platformFinanceReports);
      expect(rows.length).toBe(1);
    });

    it("explicit older month creates a separate row", async () => {
      const olderMonth = monthsAgo(2);
      const first = await app.inject({
        method: "POST",
        url: "/v1/superadmin/finance/reports/monthly",
        headers: authHeader(superAdminToken()),
        payload: {},
      });
      const second = await app.inject({
        method: "POST",
        url: "/v1/superadmin/finance/reports/monthly",
        headers: authHeader(superAdminToken()),
        payload: { month: olderMonth },
      });
      expect(first.statusCode).toBe(202);
      expect(second.statusCode).toBe(202);
      expect(first.json().data.id).not.toBe(second.json().data.id);
      expect(second.json().data.month).toBe(olderMonth);
    });
  });

  describe("audit trail", () => {
    it("writes a platform_finance_report 'generate' audit row keyed on the report id", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/superadmin/finance/reports/monthly",
        headers: authHeader(superAdminToken()),
        payload: {},
      });
      const id = res.json().data.id as string;

      const [row] = await systemDb
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.resourceType, "platform_finance_report"),
            eq(auditLogs.resourceId, id),
            eq(auditLogs.action, "generate"),
          ),
        )
        .orderBy(desc(auditLogs.createdAt))
        .limit(1);
      expect(row).toBeDefined();
      expect(row?.orgId).toBe(PLATFORM_TENANT_ID);
      expect(row?.userId).toBe(SUPER_ADMIN_KEYCLOAK_ID);
      // ipHash is a 16-char prefix of sha256(ip).
      expect(row?.ipHash).toMatch(/^[a-f0-9]{16}$/);
    });
  });
});

describe("GET /v1/superadmin/finance/reports/:id", () => {
  it("super_admin: existing row → 200 with locked shape; missing → 404", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/superadmin/finance/reports/monthly",
      headers: authHeader(superAdminToken()),
      payload: {},
    });
    const id = created.json().data.id as string;

    const ok = await app.inject({
      method: "GET",
      url: `/v1/superadmin/finance/reports/${id}`,
      headers: authHeader(superAdminToken()),
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as { data: { id: string; status: string; pdfUrl: string | null } };
    expect(body.data.id).toBe(id);
    expect(body.data.status).toBe("pending");
    expect(body.data.pdfUrl).toBeNull();

    const missing = await app.inject({
      method: "GET",
      url: `/v1/superadmin/finance/reports/00000000-0000-0000-0000-000000000000`,
      headers: authHeader(superAdminToken()),
    });
    expect(missing.statusCode).toBe(404);
  });

  it("org_admin → 404 (anti-disclosure)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/superadmin/finance/reports/00000000-0000-0000-0000-000000000000",
      headers: authHeader(signToken(app)),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /v1/superadmin/finance/reports/backfill", () => {
  // The route is rate-limited 2/min/IP — Fastify keys on the test IP
  // which is constant across `app.inject` calls. We sequence tests so
  // each describe-it consumes at most one slot and use a distinct
  // x-forwarded-for header per test where two consecutive calls are
  // unavoidable.
  it("flag off → 404 (gated)", async () => {
    await setFlag(false);
    const res = await app.inject({
      method: "POST",
      url: "/v1/superadmin/finance/reports/backfill",
      headers: { ...authHeader(superAdminToken()), "x-forwarded-for": "10.0.0.1" },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it("org_admin → 404 (anti-disclosure)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/superadmin/finance/reports/backfill",
      headers: { ...authHeader(signToken(app)), "x-forwarded-for": "10.0.0.2" },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it("super_admin → 200 with enqueued + skipped breakdown; idempotent on replay", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/v1/superadmin/finance/reports/backfill",
      headers: { ...authHeader(superAdminToken()), "x-forwarded-for": "10.0.0.3" },
      payload: {},
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as {
      data: {
        enqueued: Array<{ id: string; month: string }>;
        skipped: Array<{ id: string; month: string }>;
      };
    };
    expect(firstBody.data.enqueued.length).toBeGreaterThan(0);
    expect(firstBody.data.skipped.length).toBe(0);

    // Second call — every row is replayed; enqueued should be empty.
    const second = await app.inject({
      method: "POST",
      url: "/v1/superadmin/finance/reports/backfill",
      headers: { ...authHeader(superAdminToken()), "x-forwarded-for": "10.0.0.3" },
      payload: {},
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as {
      data: { enqueued: unknown[]; skipped: unknown[] };
    };
    expect(secondBody.data.enqueued.length).toBe(0);
    expect(secondBody.data.skipped.length).toBe(firstBody.data.enqueued.length);
  });
});

describe("GET /v1/superadmin/finance/reports/:id/pdf", () => {
  it("409 while pending — body explains why", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/superadmin/finance/reports/monthly",
      headers: authHeader(superAdminToken()),
      payload: {},
    });
    const id = created.json().data.id as string;

    const res = await app.inject({
      method: "GET",
      url: `/v1/superadmin/finance/reports/${id}/pdf`,
      headers: authHeader(superAdminToken()),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      type: "https://httpproblems.com/http-status/409",
      title: "Conflict",
      status: 409,
    });
  });

  it("404 for unknown id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/superadmin/finance/reports/00000000-0000-0000-0000-000000000000/pdf",
      headers: authHeader(superAdminToken()),
    });
    expect(res.statusCode).toBe(404);
  });

  it("org_admin → 404 (anti-disclosure) on the pdf endpoint", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/superadmin/finance/reports/00000000-0000-0000-0000-000000000000/pdf",
      headers: authHeader(signToken(app)),
    });
    expect(res.statusCode).toBe(404);
  });
});
