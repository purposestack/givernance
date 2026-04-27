/**
 * Issue #182 — RBAC guard denials emit structured `rbacDenial` log fields.
 *
 * Asserts that every guard primitive in `lib/guards.ts` emits a `pino.warn`
 * line with `rbacDenial.guard === <guardName>` BEFORE sending its 403/404,
 * and that the audit plugin's `onResponse` audit line on a mutating request
 * carries the same discriminator. The intent is SOC observability — Loki
 * dashboards filter on `rbacDenial.guard` to separate RBAC probing from CSRF
 * / validation / tenant-scoping denials, which all currently land as 403
 * with no other discriminator.
 *
 * Capture pattern: a `PassThrough` is injected as the Pino destination via
 * `createServer({ logStream })`, the test parses each JSON line, and asserts
 * on the captured records.
 */

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../../server.js";
import { authHeader, ensureTestTenants, signToken } from "../helpers/auth.js";

interface LogLine {
  level: number;
  msg: string;
  rbacDenial?: { guard: string; requiredRole: string | null; actualRole: string | null };
  statusCode?: number;
  // biome-ignore lint/suspicious/noExplicitAny: Pino emits arbitrary structured fields; tests inspect a subset.
  [key: string]: any;
}

let app: FastifyInstance;
const captured: LogLine[] = [];

beforeAll(async () => {
  // Pino emits one JSON line per `.warn()` / `.info()` call. Use the
  // synchronous `onLogLine` hook on `createServer` (issue #182) so writes
  // can't race the `await app.inject()` boundary.
  // Ensure ORG_A exists so the audit plugin's `withTenantContext` insert
  // doesn't fail the FK against `tenants.id` when this file runs in
  // isolation (e.g. via `vitest run rbac-denial-logs`).
  await ensureTestTenants();

  app = await createServer({
    onLogLine: (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      // A single chunk may carry multiple newline-delimited records when
      // Node coalesces writes, so split before parsing.
      for (const record of trimmed.split("\n")) {
        if (!record.trim()) continue;
        try {
          captured.push(JSON.parse(record) as LogLine);
        } catch {
          // Skip any non-JSON noise.
        }
      }
    },
  });
  await app.ready();
});

beforeEach(() => {
  captured.length = 0;
});

afterAll(async () => {
  await app.close();
});

function findRbacDenial(guard: string): LogLine | undefined {
  return captured.find((line) => line.rbacDenial?.guard === guard && line.msg === "rbac denial");
}

function findAuditWithRbacDenial(guard: string): LogLine | undefined {
  return captured.find((line) => line.msg === "audit" && line.rbacDenial?.guard === guard);
}

describe("RBAC guard denials emit structured rbacDenial log fields (issue #182)", () => {
  it("requireWrite emits rbacDenial.guard='requireWrite' for a viewer write", async () => {
    const viewerToken = signToken(app, { role: "viewer" });
    const res = await app.inject({
      method: "POST",
      url: "/v1/donations",
      headers: authHeader(viewerToken),
      payload: {
        constituentId: "00000000-0000-0000-0000-000000000999",
        amountCents: 1000,
        currency: "EUR",
        donatedAt: "2026-01-15T00:00:00.000Z",
      },
    });
    expect(res.statusCode).toBe(403);
    // The audit plugin emits its `info` line in `onResponse`, which Fastify
    // fires AFTER the response has been sent. Yield long enough for the
    // hook chain (incl. its inner `withTenantContext` DB transaction) to
    // finish before asserting on the captured array.
    await new Promise((r) => setTimeout(r, 50));

    // Lock the body shape so a regression to a plain string / `{error}` is
    // caught here and not at runtime by a SOC dashboard query.
    expect(res.json()).toMatchObject({
      type: "https://httpproblems.com/http-status/403",
      title: "Forbidden",
      status: 403,
    });

    const denial = findRbacDenial("requireWrite");
    expect(denial).toBeDefined();
    expect(denial?.rbacDenial).toMatchObject({
      guard: "requireWrite",
      requiredRole: "user|org_admin",
      actualRole: "viewer",
    });

    // Issue #182 acceptance: audit line on a mutating request carries the
    // same discriminator so SOC dashboards keyed off the audit message can
    // filter on rbacDenial.guard without scanning every warn line.
    const auditLine = findAuditWithRbacDenial("requireWrite");
    expect(auditLine).toBeDefined();
    expect(auditLine?.statusCode).toBe(403);
  });

  it("requireOrgAdmin emits rbacDenial.guard='requireOrgAdmin' for a 'user' role", async () => {
    const userToken = signToken(app, { role: "user" });
    const res = await app.inject({
      method: "GET",
      url: "/v1/users",
      headers: authHeader(userToken),
    });
    expect(res.statusCode).toBe(403);

    const denial = findRbacDenial("requireOrgAdmin");
    expect(denial).toBeDefined();
    expect(denial?.rbacDenial).toMatchObject({
      guard: "requireOrgAdmin",
      requiredRole: "org_admin",
      actualRole: "user",
    });
  });

  it("requireAuth emits rbacDenial.guard='requireAuth' on unauthenticated calls", async () => {
    // GET routes don't go through the audit plugin's mutating-method gate,
    // so we only assert the warn line was emitted by the guard itself.
    const res = await app.inject({ method: "GET", url: "/v1/constituents" });
    expect(res.statusCode).toBe(401);

    const denial = findRbacDenial("requireAuth");
    expect(denial).toBeDefined();
    expect(denial?.rbacDenial).toMatchObject({
      guard: "requireAuth",
      requiredRole: null,
      actualRole: null,
    });
  });

  it("requireSuperAdmin emits rbacDenial.guard='requireSuperAdmin' (and 404 not 403)", async () => {
    // Super-admin guard returns 404 to avoid disclosing existence (SEC-5).
    // The denial discriminator still fires so SOC can spot probing.
    const orgAdminToken = signToken(app, { role: "org_admin" });
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/admin/impersonation/00000000-0000-0000-0000-000000000000",
      headers: authHeader(orgAdminToken),
    });
    expect(res.statusCode).toBe(404);

    const denial = findRbacDenial("requireSuperAdmin");
    expect(denial).toBeDefined();
    expect(denial?.rbacDenial).toMatchObject({
      guard: "requireSuperAdmin",
      requiredRole: "super_admin",
      actualRole: "org_admin",
    });
  });

  it("requireSuperAdminOrOwnOrgAdmin emits its discriminator when orgId differs", async () => {
    // Org_admin of tenant A trying to act on tenant B's domain CRUD —
    // guard returns 403 (not 404) because the caller is authenticated and
    // the route is namespaced by `:orgId` rather than super-admin-only.
    const otherOrg = "00000000-0000-0000-0000-0000000000ff";
    const res = await app.inject({
      method: "POST",
      url: `/v1/tenants/${otherOrg}/domains`,
      headers: authHeader(signToken(app, { role: "org_admin" })),
      payload: { domain: "example.org" },
    });
    expect(res.statusCode).toBe(403);

    const denial = findRbacDenial("requireSuperAdminOrOwnOrgAdmin");
    expect(denial).toBeDefined();
    expect(denial?.rbacDenial).toMatchObject({
      guard: "requireSuperAdminOrOwnOrgAdmin",
      requiredRole: "super_admin|org_admin(own)",
      actualRole: "org_admin",
    });
  });

  it("successful requests carry NO rbacDenial discriminator on the audit line", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/users",
      headers: authHeader(signToken(app, { role: "org_admin" })),
    });
    expect(res.statusCode).toBe(200);

    // No `rbac denial` warn line should have been emitted on the success path.
    expect(captured.find((line) => line.msg === "rbac denial")).toBeUndefined();
  });
});
