/**
 * Integration coverage for the public self-serve signup flow (issue #108).
 *
 * Exercises the four endpoints + the cleanup helper end-to-end against
 * the real test DB (migration 0021 applied). CAPTCHA fails open in
 * NODE_ENV=test so no external provider is hit.
 */

import { randomUUID } from "node:crypto";
import {
  auditLogs,
  invitations,
  outboxEvents,
  tenantDomains,
  tenants,
  users,
} from "@givernance/shared/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";
import { redis } from "../../lib/redis.js";
import { cleanupUnverifiedTenants } from "../../modules/signup/service.js";
import { createServer } from "../../server.js";

let app: FastifyInstance;

/** Use a suite-unique prefix so signup slugs don't collide across runs. */
const RUN = `sg${Date.now().toString(36)}${Math.floor(Math.random() * 1_000_000).toString(36)}`;
const slug = (name: string) => `${RUN}-${name}`.slice(0, 48);

/** Names we create in each test — cleaned up in `afterEach`. */
const createdTenantSlugs = new Set<string>();

function registerSlug(name: string): string {
  const s = slug(name);
  createdTenantSlugs.add(s);
  return s;
}

beforeAll(async () => {
  app = await createServer();
  await app.ready();
});

beforeEach(async () => {
  // Clear any rate-limiter + per-email signup counters from Redis so the
  // 5/hour limits don't poison successive tests. Scoped deletes only — a
  // full `flushdb` would destroy unrelated test fixtures (ENG-3).
  const keys = await redis.keys("*rate-limit*");
  const resendKeys = await redis.keys("signup:resend:*");
  const all = [...keys, ...resendKeys];
  if (all.length > 0) {
    await redis.del(...all);
  }
});

afterAll(async () => {
  await app.close();
});

afterEach(async () => {
  if (createdTenantSlugs.size === 0) return;
  const slugList = [...createdTenantSlugs];
  const rows = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(inArray(tenants.slug, slugList));
  const ids = rows.map((r) => r.id);
  if (ids.length > 0) {
    // audit_logs has ON DELETE RESTRICT on org_id AND an immutability trigger
    // that blocks DELETE. Temporarily disable the trigger so test fixtures
    // can be torn down; re-enable it immediately after. This matches the
    // pattern that other integration tests would use if they generated audit
    // logs — production never runs without the trigger.
    await db.execute(sql`ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_immutable`);
    try {
      await db.delete(auditLogs).where(inArray(auditLogs.orgId, ids));
    } finally {
      await db.execute(sql`ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_immutable`);
    }
    await db.delete(outboxEvents).where(inArray(outboxEvents.tenantId, ids));
    await db.delete(tenants).where(inArray(tenants.id, ids));
  }
  createdTenantSlugs.clear();
});

describe("POST /v1/public/signup", () => {
  it("creates a provisional tenant + invitation + outbox events, returns 201", async () => {
    const slugA = registerSlug("happy");
    const email = `admin+${slugA}@example.org`;

    const res = await app.inject({
      method: "POST",
      url: "/v1/public/signup",
      headers: { "x-captcha-token": "test-token" },
      payload: {
        orgName: "Happy NGO",
        slug: slugA,
        firstName: "Happy",
        lastName: "Admin",
        email,
        country: "FR",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ data: { tenantId: string; email: string } }>();
    expect(body.data.email).toBe(email);

    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, body.data.tenantId));
    expect(tenant?.status).toBe("provisional");
    expect(tenant?.createdVia).toBe("self_serve");
    expect(tenant?.verifiedAt).toBeNull();
    expect(tenant?.slug).toBe(slugA);

    const [invite] = await db
      .select()
      .from(invitations)
      .where(and(eq(invitations.orgId, body.data.tenantId), eq(invitations.email, email)));
    expect(invite).toBeDefined();
    expect(invite?.role).toBe("org_admin");
    expect(invite?.acceptedAt).toBeNull();

    const { rows: events } = await db.execute<{ type: string }>(
      sql`SELECT type FROM outbox_events WHERE tenant_id = ${body.data.tenantId} ORDER BY created_at ASC`,
    );
    const types = events.map((r) => r.type);
    expect(types).toContain("tenant.self_signup_started");
    expect(types).toContain("tenant.signup_verification_requested");
  });

  it("rejects a reserved slug with 422", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/public/signup",
      headers: { "x-captcha-token": "test-token" },
      payload: {
        orgName: "Admin NGO",
        slug: "admin",
        firstName: "A",
        lastName: "B",
        email: `admin+admin@example.org`,
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it("rejects a duplicate slug with 409", async () => {
    const slugD = registerSlug("dup");
    const base = {
      orgName: "Dup NGO",
      slug: slugD,
      firstName: "D",
      lastName: "U",
      email: `admin+${slugD}@example.org`,
    };
    const first = await app.inject({
      method: "POST",
      url: "/v1/public/signup",
      headers: { "x-captcha-token": "test-token" },
      payload: base,
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: "/v1/public/signup",
      headers: { "x-captcha-token": "test-token" },
      payload: { ...base, email: `other+${slugD}@example.org` },
    });
    expect(second.statusCode).toBe(409);
  });

  it("rejects when the signup email's domain is already claimed by a verified tenant (409)", async () => {
    // Seed an existing "big NGO" tenant with a verified domain.
    const existingSlug = registerSlug("existing");
    const [existingTenant] = await db
      .insert(tenants)
      .values({
        name: "Existing NGO",
        slug: existingSlug,
        status: "active",
        createdVia: "enterprise",
      })
      .returning({ id: tenants.id });
    if (!existingTenant) throw new Error("seed failed");
    const domain = `${RUN}.ngo`;
    await db.insert(tenantDomains).values({
      orgId: existingTenant.id,
      domain,
      state: "verified",
      dnsTxtValue: `givernance-verify=${RUN}-padding-padding-padding`,
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/public/signup",
      headers: { "x-captcha-token": "test-token" },
      payload: {
        orgName: "Competing NGO",
        slug: registerSlug("compete"),
        firstName: "C",
        lastName: "O",
        email: `alice@${domain}`,
      },
    });
    expect(res.statusCode).toBe(409);
  });

  it("allows a personal-email (gmail) signup since personal domains cannot claim tenant identity", async () => {
    const slugP = registerSlug("personal");
    const res = await app.inject({
      method: "POST",
      url: "/v1/public/signup",
      headers: { "x-captcha-token": "test-token" },
      payload: {
        orgName: "Small NGO",
        slug: slugP,
        firstName: "Small",
        lastName: "Admin",
        email: `tresorier+${slugP}@gmail.com`,
      },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe("POST /v1/public/signup/resend", () => {
  it("re-emits the verification token and outbox event when the email matches a provisional tenant", async () => {
    const slugR = registerSlug("resend");
    const email = `admin+${slugR}@example.org`;

    await app.inject({
      method: "POST",
      url: "/v1/public/signup",
      headers: { "x-captcha-token": "test-token" },
      payload: {
        orgName: "Resend NGO",
        slug: slugR,
        firstName: "R",
        lastName: "E",
        email,
      },
    });

    const [invBefore] = await db
      .select({ id: invitations.id, token: invitations.token })
      .from(invitations)
      .where(eq(invitations.email, email));
    expect(invBefore).toBeDefined();

    const res = await app.inject({
      method: "POST",
      url: "/v1/public/signup/resend",
      payload: { email },
    });
    expect(res.statusCode).toBe(204);

    const [invAfter] = await db
      .select({ id: invitations.id, token: invitations.token })
      .from(invitations)
      .where(eq(invitations.email, email));
    expect(invAfter?.token).not.toBe(invBefore?.token);
  });

  it("returns 204 even when the email is unknown (no enumeration oracle)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/public/signup/resend",
      payload: { email: `never-registered-${RUN}@example.org` },
    });
    expect(res.statusCode).toBe(204);
  });
});

describe("POST /v1/public/signup/verify", () => {
  async function createSignup(
    name: string,
  ): Promise<{ tenantId: string; email: string; token: string }> {
    const s = registerSlug(name);
    const email = `admin+${s}@example.org`;
    const res = await app.inject({
      method: "POST",
      url: "/v1/public/signup",
      headers: { "x-captcha-token": "test-token" },
      payload: {
        orgName: `${name} NGO`,
        slug: s,
        firstName: "First",
        lastName: "Last",
        email,
      },
    });
    expect(res.statusCode).toBe(201);
    const tenantId = res.json<{ data: { tenantId: string } }>().data.tenantId;
    const [inv] = await db
      .select({ token: invitations.token })
      .from(invitations)
      .where(eq(invitations.email, email));
    return { tenantId, email, token: inv?.token ?? "" };
  }

  it("transitions the tenant to active + JIT-creates the first admin with provisional flag", async () => {
    const { tenantId, email, token } = await createSignup("verify-happy");

    const res = await app.inject({
      method: "POST",
      url: "/v1/public/signup/verify",
      payload: { token, firstName: "Alice", lastName: "Anderson" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ data: { userId: string; provisionalUntil: string } }>();

    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(tenant?.status).toBe("active");
    expect(tenant?.verifiedAt).not.toBeNull();

    const [user] = await db.select().from(users).where(eq(users.id, body.data.userId));
    expect(user?.email).toBe(email);
    expect(user?.firstAdmin).toBe(true);
    expect(user?.provisionalUntil).not.toBeNull();
    expect(user?.role).toBe("org_admin");

    const [inv] = await db
      .select({ acceptedAt: invitations.acceptedAt })
      .from(invitations)
      .where(eq(invitations.email, email));
    expect(inv?.acceptedAt).not.toBeNull();
  });

  it("returns 410 when the same token is used twice", async () => {
    const { token } = await createSignup("verify-twice");
    const first = await app.inject({
      method: "POST",
      url: "/v1/public/signup/verify",
      payload: { token, firstName: "A", lastName: "B" },
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: "POST",
      url: "/v1/public/signup/verify",
      payload: { token, firstName: "A", lastName: "B" },
    });
    // SEC-6: collapsed to a single 410 for every failure mode.
    expect(second.statusCode).toBe(410);
  });

  it("returns 410 when the token is unknown", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/public/signup/verify",
      payload: {
        token: "00000000-0000-0000-0000-000000000000",
        firstName: "A",
        lastName: "B",
      },
    });
    expect(res.statusCode).toBe(410);
  });
});

describe("GET /v1/public/tenants/lookup", () => {
  it("returns contact_admin when the domain is already claimed", async () => {
    const existingSlug = registerSlug("lookup-existing");
    const [existing] = await db
      .insert(tenants)
      .values({
        name: "Lookup NGO",
        slug: existingSlug,
        status: "active",
        createdVia: "enterprise",
      })
      .returning({ id: tenants.id });
    if (!existing) throw new Error("seed failed");
    const domain = `${RUN}-lookup.ngo`;
    await db.insert(tenantDomains).values({
      orgId: existing.id,
      domain,
      state: "verified",
      dnsTxtValue: `givernance-verify=${RUN}-lookup-padding-padding-xx`,
    });

    const res = await app.inject({
      method: "GET",
      url: `/v1/public/tenants/lookup?email=${encodeURIComponent(`bob@${domain}`)}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: { hasExistingTenant: boolean; hint: string };
    }>();
    expect(body.data.hasExistingTenant).toBe(true);
    expect(body.data.hint).toBe("contact_admin");
    // SEC-9: we do NOT leak the orgSlug publicly.
    expect((body.data as Record<string, unknown>).orgSlug).toBeUndefined();
  });

  it("returns create_new for a personal-email domain even if someone has a gmail.com claim", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/public/tenants/lookup?email=${encodeURIComponent("someone@gmail.com")}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: { hasExistingTenant: boolean; hint: string };
    }>();
    expect(body.data.hasExistingTenant).toBe(false);
    expect(body.data.hint).toBe("create_new");
  });
});

describe("cleanupUnverifiedTenants", () => {
  it("deletes provisional self-serve tenants whose verification token has expired", async () => {
    // Seed an expired provisional tenant directly.
    const s = registerSlug("cleanup");
    const [tenant] = await db
      .insert(tenants)
      .values({ name: "Cleanup NGO", slug: s, status: "provisional", createdVia: "self_serve" })
      .returning({ id: tenants.id });
    if (!tenant) throw new Error("seed failed");
    const tid = tenant.id;
    const expired = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await db.insert(invitations).values({
      orgId: tid,
      email: `expired+${s}@example.org`,
      role: "org_admin",
      token: randomUUID(),
      purpose: "signup_verification",
      expiresAt: expired,
    });
    // Back-date the tenant's createdAt so the cutoff filter picks it up.
    await db.execute(
      sql`UPDATE tenants SET created_at = ${expired.toISOString()} WHERE id = ${tid}`,
    );

    const reaped = await cleanupUnverifiedTenants(24);
    expect(reaped).toBeGreaterThanOrEqual(1);

    const [check] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tid));
    expect(check).toBeUndefined();
    createdTenantSlugs.delete(s);
  });

  it("does NOT delete active tenants", async () => {
    const s = registerSlug("cleanup-active");
    const [tenant] = await db
      .insert(tenants)
      .values({
        name: "Active NGO",
        slug: s,
        status: "active",
        createdVia: "self_serve",
        verifiedAt: new Date(),
      })
      .returning({ id: tenants.id });
    if (!tenant) throw new Error("seed failed");

    await cleanupUnverifiedTenants(24);

    const [check] = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, tenant.id));
    expect(check).toBeDefined();
  });
});
