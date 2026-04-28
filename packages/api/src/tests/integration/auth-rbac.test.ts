import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { blocklistUser } from "../../modules/session/service.js";
import { createServer } from "../../server.js";
import { authHeader, signToken } from "../helpers/auth.js";

const JWT_COOKIE_NAME = "givernance_jwt";
const CSRF_COOKIE_NAME = "csrf-token";
const CSRF_HEADER_NAME = "x-csrf-token";

function authCookieHeader(token: string, csrfToken?: string): string {
  const cookies = [`${JWT_COOKIE_NAME}=${token}`];
  if (csrfToken) cookies.push(`${CSRF_COOKIE_NAME}=${csrfToken}`);
  return cookies.join("; ");
}

let app: FastifyInstance;

beforeAll(async () => {
  app = await createServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

// ─── Health Endpoints ────────────────────────────────────────────────────────

describe("Health endpoints", () => {
  it("GET /healthz returns 200 OK", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("GET /readyz returns 200 when database is reachable", async () => {
    const res = await app.inject({ method: "GET", url: "/readyz" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ready", db: "ok" });
  });
});

// ─── RBAC — Unauthenticated Access ──────────────────────────────────────────

describe("RBAC — unauthenticated access", () => {
  it("GET /v1/constituents without token returns 401", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/constituents" });

    expect(res.statusCode).toBe(401);
  });

  it("POST /v1/constituents without token returns 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents",
      payload: { firstName: "Test", lastName: "User", type: "donor" },
    });

    expect(res.statusCode).toBe(401);
  });

  it("GET /v1/users without token returns 401", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/users" });
    expect(res.statusCode).toBe(401);
  });

  it("GET /v1/audit without token returns 401", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/audit" });
    expect(res.statusCode).toBe(401);
  });
});

// ─── RBAC — Authenticated Access ────────────────────────────────────────────

describe("RBAC — authenticated access", () => {
  it("GET /v1/constituents with valid token returns 200", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents",
      headers: authHeader(signToken(app)),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      data: expect.any(Array),
      pagination: expect.objectContaining({ page: 1 }),
    });
  });

  it("rejects cookie-authenticated mutating requests without a matching CSRF token", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/users/00000000-0000-0000-0000-000000000000",
      headers: {
        cookie: authCookieHeader(token, "csrf-cookie-token"),
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      title: "Forbidden",
      detail: "Missing or invalid CSRF double-submit token",
    });
  });

  it("accepts cookie-authenticated mutating requests with a valid double-submit token", async () => {
    const token = signToken(app);
    const csrfToken = "csrf-cookie-token";
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/users/00000000-0000-0000-0000-000000000000",
      headers: {
        cookie: authCookieHeader(token, csrfToken),
        [CSRF_HEADER_NAME]: csrfToken,
      },
    });

    expect(res.statusCode).toBe(404);
  });

  it("does not require CSRF for mutating requests authenticated by Authorization header", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/users/00000000-0000-0000-0000-000000000000",
      headers: authHeader(signToken(app)),
    });

    expect(res.statusCode).toBe(404);
  });
});

// ─── Tenant Routes ──────────────────────────────────────────────────────────

describe("Tenant routes", () => {
  it("POST /v1/tenants without admin secret returns 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tenants",
      payload: { name: "Test Org", slug: "test-org" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("POST /v1/tenants with admin secret returns 201", async () => {
    const slug = `test-org-${Date.now()}`;
    const res = await app.inject({
      method: "POST",
      url: "/v1/tenants",
      headers: { "x-admin-secret": process.env["ADMIN_SECRET"] ?? "" },
      payload: { name: "Test Org", slug },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ data: { id: string; name: string; slug: string } }>();
    expect(body.data).toHaveProperty("id");
    expect(body.data.name).toBe("Test Org");
    expect(body.data.slug).toBe(slug);
  });

  it("GET /v1/tenants with admin secret returns 200", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/tenants",
      headers: { "x-admin-secret": process.env["ADMIN_SECRET"] ?? "" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("data");
  });

  it("GET /v1/tenants/:id returns 404 for non-existent tenant", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/tenants/00000000-0000-0000-0000-000000000000",
      headers: { "x-admin-secret": process.env["ADMIN_SECRET"] ?? "" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("DELETE /v1/tenants/:id returns 404 for non-existent tenant", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/tenants/00000000-0000-0000-0000-000000000000",
      headers: { "x-admin-secret": process.env["ADMIN_SECRET"] ?? "" },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ─── User Routes ────────────────────────────────────────────────────────────

describe("User routes", () => {
  it("GET /v1/users/me returns 404 when user profile doesn't exist in DB", async () => {
    // ADR-021 — the auth-boundary check rejects tokens whose `(sub,
    // org_id)` tuple has no active users row, so the in-handler 404
    // path is now reachable only via super_admin (which bypasses the
    // active-row check). Mint a super_admin token with a synthetic sub
    // that has no row anywhere; /me's tenant-scoped lookup falls through
    // to the 404 branch.
    const orphanToken = signToken(app, {
      sub: "00000000-0000-0000-0000-00000000ffff",
      realm_access: { roles: ["super_admin"] },
    });
    const res = await app.inject({
      method: "GET",
      url: "/v1/users/me",
      headers: authHeader(orphanToken),
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET /v1/users requires org_admin role", async () => {
    const viewerToken = signToken(app, { role: "viewer" });
    const res = await app.inject({
      method: "GET",
      url: "/v1/users",
      headers: authHeader(viewerToken),
    });
    expect(res.statusCode).toBe(403);
  });

  it("GET /v1/users with org_admin returns 200", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/users",
      headers: authHeader(signToken(app)),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("data");
  });

  it("PATCH /v1/users/:id — non-admin (user role) cannot update other members (403)", async () => {
    // Issue #161: combined PATCH replaces the legacy `/role` sub-route.
    // Non-admins still hit `requireOrgAdmin` and get 403.
    const userToken = signToken(app, { role: "user" });
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/users/00000000-0000-0000-0000-000000000000",
      headers: authHeader(userToken),
      payload: { role: "org_admin" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("DELETE /v1/users/:id returns 404 for non-existent user", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/users/00000000-0000-0000-0000-000000000000",
      headers: authHeader(signToken(app)),
    });
    expect(res.statusCode).toBe(404);
  });
});

// ─── Invitation Routes ──────────────────────────────────────────────────────

describe("Invitation routes", () => {
  it("POST /v1/invitations requires org_admin role", async () => {
    const userToken = signToken(app, { role: "user" });
    const res = await app.inject({
      method: "POST",
      url: "/v1/invitations",
      headers: authHeader(userToken),
      payload: { email: "invite@example.org" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("POST /v1/invitations/:token/accept returns 410 generic for unknown token", async () => {
    // SEC-6: every accept failure mode (unknown / expired / already used /
    // hijack) collapses to a single 410 to remove the enumeration oracle.
    const res = await app.inject({
      method: "POST",
      url: "/v1/invitations/00000000-0000-0000-0000-000000000000/accept",
      payload: { firstName: "Jane", lastName: "Doe", password: "long-enough-password-1" },
    });
    expect(res.statusCode).toBe(410);
  });
});

// ─── Audit Routes ───────────────────────────────────────────────────────────

describe("Audit routes", () => {
  it("GET /v1/audit requires org_admin role", async () => {
    const userToken = signToken(app, { role: "user" });
    const res = await app.inject({
      method: "GET",
      url: "/v1/audit",
      headers: authHeader(userToken),
    });
    expect(res.statusCode).toBe(403);
  });

  it("GET /v1/audit with org_admin returns paginated results", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/audit",
      headers: authHeader(signToken(app)),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("data");
    expect(body).toHaveProperty("pagination");
    expect(body.pagination).toMatchObject({
      page: 1,
      perPage: 20,
    });
  });
});

// ─── Auth boundary (ADR-021) ────────────────────────────────────────────────

describe("Auth boundary (ADR-021)", () => {
  // No active `users` row resolves for the JWT's `(sub, org_id)`. The
  // boundary closes the soft-delete + tenant-removal window: a token
  // signed for a tenant the user no longer belongs to is rejected
  // before any handler runs, instead of returning 200 with stale data.
  it("rejects a token whose (sub, org_id) has no active users row (no_active_membership → 401)", async () => {
    const tokenWithoutRow = signToken(app, {
      sub: "00000000-0000-0000-0000-aaaaaaaaaaaa",
      // ORG_A is seeded by ensureTestTenants but the synthetic sub has
      // no users row in it.
    });
    const res = await app.inject({
      method: "GET",
      url: "/v1/users/me",
      headers: authHeader(tokenWithoutRow),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ detail: string }>().detail).toBe("Account no longer active.");
  });

  // A JWT without an `org_id` claim is rejected upstream by
  // `verifyKeycloakJwt` (every token in this Keycloak realm carries
  // one — super_admin tokens too, since the realm mapper can't omit
  // the claim). The auth plugin therefore sees this as `none` and
  // `requireAuth` returns the generic "Authentication required."
  // message, NOT a granular `no_org_claim` boundary 401. Pinning the
  // actual surfaced behaviour here so a regression that returned 200
  // with `request.auth.orgId === undefined` would fail loud, AND so
  // ADR-021's discriminator list stays honest about what fires.
  it("rejects a JWT without org_id at the verifier (401 'Authentication required')", async () => {
    const tokenWithoutOrg = signToken(app, {
      sub: "00000000-0000-0000-0000-dddddddddddd",
      org_id: undefined,
    });
    const res = await app.inject({
      method: "GET",
      url: "/v1/users/me",
      headers: authHeader(tokenWithoutOrg),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ detail: string }>().detail).toBe("Authentication required");
  });

  // User-blocklist branch — the production hook called by DELETE
  // /v1/users/:id. Asserts the boundary catches an outstanding token
  // whose `sub` was just blocklisted, even though the JWT signature is
  // still valid and a corresponding active users row could in theory
  // still exist (the blocklist runs BEFORE the active-row check).
  it("rejects a token whose sub is on the user blocklist (user_revoked → 401)", async () => {
    const blockedSub = "00000000-0000-0000-0000-bbbbbbbbbbbb";
    await blocklistUser(blockedSub, 60);
    const blockedToken = signToken(app, { sub: blockedSub });
    const res = await app.inject({
      method: "GET",
      url: "/v1/users/me",
      headers: authHeader(blockedToken),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ detail: string }>().detail).toBe("Account no longer active.");
  });
});
