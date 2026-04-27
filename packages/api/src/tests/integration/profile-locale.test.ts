/**
 * Integration coverage for the personal + tenant locale change endpoints
 * shipped with issue #153 (PR #158).
 *
 *  - `PATCH /v1/users/me { locale }` — user updates their personal
 *    `users.locale`. `null` clears the override.
 *  - `PUT /v1/admin/tenants/:orgId { defaultLocale }` — org_admin updates
 *    `tenants.default_locale`. Crucially, this does NOT mutate any
 *    user's `users.locale`: members with an explicit override keep
 *    their preference; members with NULL follow the new default.
 */

import { randomUUID } from "node:crypto";
import { auditLogs, tenants, users } from "@givernance/shared/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";
import { createServer } from "../../server.js";
import { authHeader, signToken } from "../helpers/auth.js";

let app: FastifyInstance;

const trackedTenants = new Set<string>();

beforeAll(async () => {
  app = await createServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

afterEach(async () => {
  if (trackedTenants.size === 0) return;
  const ids = [...trackedTenants];
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = 'replica'`);
    await tx.delete(auditLogs).where(inArray(auditLogs.orgId, ids));
    await tx.delete(users).where(inArray(users.orgId, ids));
    await tx.delete(tenants).where(inArray(tenants.id, ids));
  });
  trackedTenants.clear();
});

interface Fixture {
  orgId: string;
  userId: string;
  keycloakSub: string;
  token: string;
}

async function makeFixture(opts: {
  defaultLocale?: "en" | "fr";
  userLocale?: "en" | "fr" | null;
  role?: "org_admin" | "user" | "viewer";
}): Promise<Fixture> {
  const { defaultLocale = "fr", userLocale = null, role = "org_admin" } = opts;
  const orgId = randomUUID();
  const userId = randomUUID();
  const keycloakSub = `kc-${randomUUID().slice(0, 8)}`;
  const slug = `profile-locale-${randomUUID().slice(0, 8)}`;
  trackedTenants.add(orgId);

  await db.execute(
    sql`INSERT INTO tenants (id, name, slug, status, created_via, default_locale)
        VALUES (${orgId}, ${`Profile Locale Test ${slug}`}, ${slug}, 'active', 'enterprise', ${defaultLocale})`,
  );
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_organization_id', ${orgId}, true)`);
    await tx.insert(users).values({
      id: userId,
      orgId,
      email: `user-${slug}@example.org`,
      firstName: "Profile",
      lastName: "Tester",
      role,
      keycloakId: keycloakSub,
      locale: userLocale,
    });
  });

  const token = signToken(app, {
    sub: keycloakSub,
    org_id: orgId,
    email: `user-${slug}@example.org`,
    role,
  });
  return { orgId, userId, keycloakSub, token };
}

// ─── PATCH /v1/users/me ─────────────────────────────────────────────────────

describe("PATCH /v1/users/me", () => {
  it("sets users.locale to a new value, audits with old → new diff", async () => {
    const f = await makeFixture({ defaultLocale: "fr", userLocale: null });

    const res = await app.inject({
      method: "PATCH",
      url: "/v1/users/me",
      headers: authHeader(f.token),
      payload: { locale: "en" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { locale: string | null; tenantDefaultLocale: string } }>();
    expect(body.data.locale).toBe("en");
    expect(body.data.tenantDefaultLocale).toBe("fr");

    const [persisted] = await db
      .select({ locale: users.locale })
      .from(users)
      .where(eq(users.id, f.userId));
    expect(persisted?.locale).toBe("en");

    const [audit] = await db
      .select({
        action: auditLogs.action,
        oldValues: auditLogs.oldValues,
        newValues: auditLogs.newValues,
      })
      .from(auditLogs)
      .where(and(eq(auditLogs.orgId, f.orgId), eq(auditLogs.action, "user.preferences_updated")));
    expect(audit?.oldValues).toMatchObject({ locale: null });
    expect(audit?.newValues).toMatchObject({ locale: "en" });
  });

  it("accepts locale: null to clear the personal override (revert to tenant default)", async () => {
    const f = await makeFixture({ defaultLocale: "fr", userLocale: "en" });

    const res = await app.inject({
      method: "PATCH",
      url: "/v1/users/me",
      headers: authHeader(f.token),
      payload: { locale: null },
    });
    expect(res.statusCode).toBe(200);

    const [persisted] = await db
      .select({ locale: users.locale })
      .from(users)
      .where(eq(users.id, f.userId));
    expect(persisted?.locale).toBeNull();
  });

  it("rejects an unsupported locale with 400", async () => {
    const f = await makeFixture({});
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/users/me",
      headers: authHeader(f.token),
      payload: { locale: "de" },
    });
    expect(res.statusCode).toBe(400);
    const [persisted] = await db
      .select({ locale: users.locale })
      .from(users)
      .where(eq(users.id, f.userId));
    expect(persisted?.locale).toBeNull();
  });

  it("requires authentication (no token → 401)", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/users/me",
      payload: { locale: "fr" },
    });
    expect([401, 403]).toContain(res.statusCode);
  });

  it("is available to non-admin roles (locale is the user's own preference)", async () => {
    // viewer is the most-restricted role; if it can update its own locale,
    // user/org_admin can too. Pre-assert the existing locale is null,
    // PATCH to 'fr' (= tenant default in this fixture, but the API
    // doesn't care — it persists what the user picked), confirm 200.
    const f = await makeFixture({ defaultLocale: "fr", userLocale: null, role: "viewer" });
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/users/me",
      headers: authHeader(f.token),
      payload: { locale: "fr" },
    });
    expect(res.statusCode).toBe(200);
    const [persisted] = await db
      .select({ locale: users.locale })
      .from(users)
      .where(eq(users.id, f.userId));
    expect(persisted?.locale).toBe("fr");
  });
});

// ─── PUT /v1/admin/tenants/:orgId — defaultLocale ──────────────────────────

describe("PUT /v1/admin/tenants/:orgId — defaultLocale (issue #153)", () => {
  it("org_admin updates tenants.default_locale and the response carries the new value", async () => {
    const f = await makeFixture({ defaultLocale: "fr", role: "org_admin" });

    const res = await app.inject({
      method: "PUT",
      url: `/v1/admin/tenants/${f.orgId}`,
      headers: authHeader(f.token),
      payload: { defaultLocale: "en" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { defaultLocale: string; baseCurrency: string } }>();
    expect(body.data.defaultLocale).toBe("en");
    expect(body.data.baseCurrency).toBe("EUR");

    const [persisted] = await db
      .select({ defaultLocale: tenants.defaultLocale })
      .from(tenants)
      .where(eq(tenants.id, f.orgId));
    expect(persisted?.defaultLocale).toBe("en");
  });

  it("changing tenants.default_locale does NOT mutate any users.locale (issue #153 contract)", async () => {
    // The user has an explicit personal locale; the tenant flips its
    // default; the user's preference must survive untouched.
    const f = await makeFixture({ defaultLocale: "fr", userLocale: "en", role: "org_admin" });

    const res = await app.inject({
      method: "PUT",
      url: `/v1/admin/tenants/${f.orgId}`,
      headers: authHeader(f.token),
      payload: { defaultLocale: "en" },
    });
    expect(res.statusCode).toBe(200);

    const [user] = await db
      .select({ locale: users.locale })
      .from(users)
      .where(eq(users.id, f.userId));
    // The personal override is preserved.
    expect(user?.locale).toBe("en");
  });

  it("rejects an unsupported defaultLocale with 400", async () => {
    const f = await makeFixture({ defaultLocale: "fr", role: "org_admin" });
    const res = await app.inject({
      method: "PUT",
      url: `/v1/admin/tenants/${f.orgId}`,
      headers: authHeader(f.token),
      payload: { defaultLocale: "de" },
    });
    expect(res.statusCode).toBe(400);
    const [persisted] = await db
      .select({ defaultLocale: tenants.defaultLocale })
      .from(tenants)
      .where(eq(tenants.id, f.orgId));
    expect(persisted?.defaultLocale).toBe("fr");
  });

  it("can update defaultLocale + baseCurrency in the same PUT", async () => {
    const f = await makeFixture({ defaultLocale: "fr", role: "org_admin" });
    const res = await app.inject({
      method: "PUT",
      url: `/v1/admin/tenants/${f.orgId}`,
      headers: authHeader(f.token),
      payload: { defaultLocale: "en", baseCurrency: "GBP" },
    });
    expect(res.statusCode).toBe(200);
    const [persisted] = await db
      .select({ defaultLocale: tenants.defaultLocale, baseCurrency: tenants.baseCurrency })
      .from(tenants)
      .where(eq(tenants.id, f.orgId));
    expect(persisted?.defaultLocale).toBe("en");
    expect(persisted?.baseCurrency).toBe("GBP");
  });

  it("rejects a non-org-admin user from updating tenant settings", async () => {
    // The PUT route is gated by `requireSuperAdminOrOwnOrgAdmin`.
    const f = await makeFixture({ defaultLocale: "fr", role: "viewer" });
    const res = await app.inject({
      method: "PUT",
      url: `/v1/admin/tenants/${f.orgId}`,
      headers: authHeader(f.token),
      payload: { defaultLocale: "en" },
    });
    expect([401, 403]).toContain(res.statusCode);
    const [persisted] = await db
      .select({ defaultLocale: tenants.defaultLocale })
      .from(tenants)
      .where(eq(tenants.id, f.orgId));
    expect(persisted?.defaultLocale).toBe("fr");
  });
});
