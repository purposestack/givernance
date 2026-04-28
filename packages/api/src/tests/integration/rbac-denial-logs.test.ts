/**
 * Issue #182 + PR #185 review PJD-5 — split log discriminators.
 *
 * Asserts that:
 *   • The 401 unauth branch of every guard emits `authDenial: {guard, reason}`
 *     and the audit line carries it (NOT `rbacDenial` — that's reserved for
 *     valid-JWT role rejections so SOC dashboards filtering for RBAC probing
 *     can exclude benign cookie-expiry / token-rotation noise).
 *   • The 403/404 role-rejection branch emits `rbacDenial: {guard,
 *     requiredRoles[], tenantScoped?, actualRole}` (machine-parseable
 *     `requiredRoles` array, not a pipe-delimited string).
 *
 * Capture pattern: `createServer({onLogLine})` wires a custom Pino destination
 * so we can assert on the captured records synchronously without fighting
 * Pino's default sonic-boom batch.
 */

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../../server.js";
import { authHeader, ensureTestTenants, signToken } from "../helpers/auth.js";

interface LogLine {
  level: number;
  msg: string;
  authDenial?: { guard: string; reason: string };
  rbacDenial?: {
    guard: string;
    requiredRoles?: string[];
    tenantScoped?: boolean;
    actualRole: string | null;
  };
  statusCode?: number;
  // biome-ignore lint/suspicious/noExplicitAny: Pino emits arbitrary structured fields; tests inspect a subset.
  [key: string]: any;
}

let app: FastifyInstance;
const captured: LogLine[] = [];

beforeAll(async () => {
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

/**
 * Poll the captured array until `pred` matches, with a deadline. Replaces a
 * brittle `setTimeout(50)` that races slow CI runs (review Q1, PR #185).
 * The audit plugin's `onResponse` hook awaits a real DB tx, so the audit
 * info line lands a variable number of ms after `app.inject()` resolves —
 * we wait for the EVIDENCE rather than guessing a wall-clock budget.
 */
async function waitForLog(
  pred: (line: LogLine) => boolean,
  { timeout = 2000, interval = 10 }: { timeout?: number; interval?: number } = {},
): Promise<LogLine> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const found = captured.find(pred);
    if (found) return found;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(
    `waitForLog: timeout after ${timeout}ms; captured ${captured.length} lines; messages: ${captured.map((l) => l.msg).join(", ")}`,
  );
}

function findRbacDenial(guard: string): LogLine | undefined {
  return captured.find((line) => line.rbacDenial?.guard === guard && line.msg === "rbac denial");
}

function findAuditWithRbacDenial(guard: string): LogLine | undefined {
  return captured.find((line) => line.msg === "audit" && line.rbacDenial?.guard === guard);
}

function findAuthDenial(guard: string): LogLine | undefined {
  return captured.find((line) => line.authDenial?.guard === guard && line.msg === "auth denial");
}

describe("Guard denial discriminators (issue #182 + PR #185 review PJD-5)", () => {
  it("requireWrite — viewer write emits rbacDenial with structured requiredRoles", async () => {
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

    // Lock the RFC 9457 body shape so a regression to a plain string is
    // caught here and not at runtime by a SOC dashboard query.
    expect(res.json()).toMatchObject({
      type: "https://httpproblems.com/http-status/403",
      title: "Forbidden",
      status: 403,
    });

    // The audit plugin emits its `info` line in `onResponse`, which Fastify
    // fires AFTER the response has been sent and runs an awaited DB tx.
    // Poll the capture array with a deadline (review Q1) — robust to slow
    // CI without a wall-clock budget that risks being too short.
    await waitForLog((l) => l.msg === "audit" && l.rbacDenial?.guard === "requireWrite");

    const denial = findRbacDenial("requireWrite");
    expect(denial).toBeDefined();
    expect(denial?.rbacDenial).toEqual({
      guard: "requireWrite",
      requiredRoles: ["user", "org_admin"],
      actualRole: "viewer",
    });

    const auditLine = findAuditWithRbacDenial("requireWrite");
    expect(auditLine).toBeDefined();
    expect(auditLine?.statusCode).toBe(403);
    expect(auditLine?.authDenial).toBeUndefined();
  });

  it("requireOrgAdmin — user role emits rbacDenial.requiredRoles=['org_admin']", async () => {
    const userToken = signToken(app, { role: "user" });
    const res = await app.inject({
      method: "GET",
      url: "/v1/users",
      headers: authHeader(userToken),
    });
    expect(res.statusCode).toBe(403);

    const denial = findRbacDenial("requireOrgAdmin");
    expect(denial).toBeDefined();
    expect(denial?.rbacDenial).toEqual({
      guard: "requireOrgAdmin",
      requiredRoles: ["org_admin"],
      actualRole: "user",
    });
  });

  it("requireAuth — unauthenticated call emits authDenial (NOT rbacDenial)", async () => {
    // Review PJD-5: the 401 unauth branch is conceptually an authentication
    // denial, not an authorization denial. SOC filtering for RBAC probing
    // should EXCLUDE these so cookie-expiry noise doesn't drown out
    // genuine probes.
    const res = await app.inject({ method: "GET", url: "/v1/constituents" });
    expect(res.statusCode).toBe(401);
    // Lock the RFC 9457 body shape (review Q5).
    expect(res.json()).toMatchObject({
      type: "https://httpproblems.com/http-status/401",
      title: "Unauthorized",
      status: 401,
    });

    const auth = findAuthDenial("requireAuth");
    expect(auth).toBeDefined();
    expect(auth?.authDenial).toEqual({ guard: "requireAuth", reason: "missing_token" });

    // CRITICAL: must NOT have emitted rbacDenial — that would put unauth
    // 401s in the same SOC bucket as actual role probes.
    expect(findRbacDenial("requireAuth")).toBeUndefined();
  });

  it("requireWrite — unauthenticated POST emits authDenial (not rbacDenial)", async () => {
    // Same boundary on a different guard: even though `requireWrite` has a
    // role concept, the 401 path is auth, not RBAC.
    const res = await app.inject({
      method: "POST",
      url: "/v1/donations",
      payload: {
        constituentId: "00000000-0000-0000-0000-000000000999",
        amountCents: 1000,
        currency: "EUR",
        donatedAt: "2026-01-15T00:00:00.000Z",
      },
    });
    expect(res.statusCode).toBe(401);

    const auth = findAuthDenial("requireWrite");
    expect(auth?.authDenial).toEqual({ guard: "requireWrite", reason: "missing_token" });
    expect(findRbacDenial("requireWrite")).toBeUndefined();
  });

  it("requireSuperAdmin — non-super_admin emits rbacDenial (and 404 not 403)", async () => {
    // Super-admin guard returns 404 to avoid disclosing existence (SEC-5).
    // The denial discriminator still fires so SOC can spot probing.
    const orgAdminToken = signToken(app, { role: "org_admin" });
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/admin/impersonation/00000000-0000-0000-0000-000000000000",
      headers: authHeader(orgAdminToken),
    });
    expect(res.statusCode).toBe(404);
    // Lock the RFC 9457 body shape (review Q5).
    expect(res.json()).toMatchObject({
      type: "https://httpproblems.com/http-status/404",
      title: "Not Found",
      status: 404,
    });

    const denial = findRbacDenial("requireSuperAdmin");
    expect(denial).toBeDefined();
    expect(denial?.rbacDenial).toEqual({
      guard: "requireSuperAdmin",
      requiredRoles: ["super_admin"],
      actualRole: "org_admin",
    });
  });

  it("requireSuperAdminOrOwnOrgAdmin — wrong-tenant org_admin emits rbacDenial.tenantScoped=true", async () => {
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
    expect(denial?.rbacDenial).toEqual({
      guard: "requireSuperAdminOrOwnOrgAdmin",
      requiredRoles: ["super_admin", "org_admin"],
      tenantScoped: true,
      actualRole: "org_admin",
    });
  });

  it("successful requests carry NO denial discriminator on the audit line", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/users",
      headers: authHeader(signToken(app, { role: "org_admin" })),
    });
    expect(res.statusCode).toBe(200);

    // Neither warn line should have been emitted on the success path.
    expect(captured.find((line) => line.msg === "rbac denial")).toBeUndefined();
    expect(captured.find((line) => line.msg === "auth denial")).toBeUndefined();
  });
});
