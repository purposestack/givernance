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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../lib/db.js";
import {
  _resetKeycloakAdminSingleton,
  _setKeycloakAdminSingleton,
  type KeycloakAdminClient,
} from "../../lib/keycloak-admin.js";
import { redis } from "../../lib/redis.js";
import { cleanupUnverifiedTenants } from "../../modules/signup/service.js";
import { createServer } from "../../server.js";

let app: FastifyInstance;

/**
 * Stub Keycloak admin used by every verify call in this file. We assert the
 * service hands the right shape over the boundary; the real Admin API
 * contract is exercised by the unit tests in `keycloak-admin.test.ts`.
 *
 * `vi.fn` is typed as the `createUser` shape via the generic param so the
 * mock-method overloads (`mockClear`, `mockRejectedValueOnce`) stay accessible
 * on `kcCreateUser` while still satisfying the `KeycloakAdminClient` interface
 * when slotted into `fakeKeycloakAdmin.createUser`.
 */
const kcCreateUser = vi.fn<KeycloakAdminClient["createUser"]>(async (input) => ({
  id: `kc-${input.email}-${randomUUID().slice(0, 8)}`,
}));
const kcCreateOrganization = vi.fn<KeycloakAdminClient["createOrganization"]>(
  async ({ name, alias, attributes }) => ({
    // Real Keycloak returns a UUID here, and `tenants_keycloak_org_id_uuid_chk`
    // enforces that shape — the stub MUST return a UUID, not a debug-friendly
    // alias-based string, or the verify INSERT/UPDATE chokes on the check.
    id: randomUUID(),
    name,
    alias,
    attributes,
  }),
);
const kcAttachUserToOrg = vi.fn<KeycloakAdminClient["attachUserToOrg"]>(async () => {});
const kcGetOrganizationByAlias = vi.fn<KeycloakAdminClient["getOrganizationByAlias"]>(
  async () => null,
);
const kcResetUserPassword = vi.fn<KeycloakAdminClient["resetUserPassword"]>(async () => {});
const kcSetUserAttributes = vi.fn<KeycloakAdminClient["setUserAttributes"]>(async () => {});
const fakeKeycloakAdmin: KeycloakAdminClient = {
  createOrganization: kcCreateOrganization,
  getOrganization: vi.fn(async () => null),
  getOrganizationByAlias: kcGetOrganizationByAlias,
  deleteOrganization: vi.fn(async () => {}),
  addOrgDomain: vi.fn(async () => {}),
  attachUserToOrg: kcAttachUserToOrg,
  sendInvitation: vi.fn(async () => {}),
  bindIdpToOrganization: vi.fn(async () => {}),
  createUser: kcCreateUser,
  getUserByEmail: vi.fn(async () => null),
  resetUserPassword: kcResetUserPassword,
  setUserAttributes: kcSetUserAttributes,
  createIdentityProvider: vi.fn(async () => {}),
  deleteIdentityProvider: vi.fn(async () => {}),
  _circuitState: () => "closed",
};

/** A 12-char password — matches the route's `minLength: 12` floor. */
const TEST_PASSWORD = "Verify-12345";

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
  _setKeycloakAdminSingleton(fakeKeycloakAdmin);
  app = await createServer();
  await app.ready();
});

beforeEach(async () => {
  // Reset the KC stub spies so per-test assertions on call counts are clean.
  kcCreateUser.mockClear();
  kcCreateOrganization.mockClear();
  kcAttachUserToOrg.mockClear();
  kcGetOrganizationByAlias.mockClear();
  kcResetUserPassword.mockClear();
  kcSetUserAttributes.mockClear();
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
  _resetKeycloakAdminSingleton();
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
    // that blocks DELETE. `SET LOCAL session_replication_role = 'replica'`
    // bypasses the trigger for this transaction only — no table-level DDL,
    // no ACCESS EXCLUSIVE lock, and no race with any other test file that
    // reads audit_logs or tenants concurrently. (Matches the pattern in
    // onboarding-runtime.test.ts; production never runs with this flag.)
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = 'replica'`);
      await tx.delete(auditLogs).where(inArray(auditLogs.orgId, ids));
      await tx.delete(outboxEvents).where(inArray(outboxEvents.tenantId, ids));
      await tx.delete(tenants).where(inArray(tenants.id, ids));
    });
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

  // Regression: a user who verified under the pre-PR-#143 build has an active
  // tenant + a Givernance users row but no `keycloak_id`. The verify token is
  // already `acceptedAt`, so they're locked out — resend used to silently
  // 204 because it only matched provisional tenants. The fix opens the gate
  // for this state and clears `acceptedAt` so the next verify can complete
  // the missing Keycloak bind step.
  it("re-emits a verification token for a half-provisioned active tenant (recovery path)", async () => {
    const slugH = registerSlug("resend-half");
    const email = `admin+${slugH}@example.org`;

    // Step 1: do a normal signup + verify so we have a Givernance users row.
    await app.inject({
      method: "POST",
      url: "/v1/public/signup",
      headers: { "x-captcha-token": "test-token" },
      payload: {
        orgName: "Half NGO",
        slug: slugH,
        firstName: "H",
        lastName: "P",
        email,
      },
    });
    const [invSeed] = await db
      .select({ token: invitations.token, id: invitations.id })
      .from(invitations)
      .where(eq(invitations.email, email));
    const seedToken = invSeed?.token;
    if (!seedToken) throw new Error("seed token missing");

    const verifyRes = await app.inject({
      method: "POST",
      url: "/v1/public/signup/verify",
      payload: {
        token: seedToken,
        firstName: "Half",
        lastName: "Provisioned",
        password: TEST_PASSWORD,
      },
    });
    expect(verifyRes.statusCode).toBe(201);

    // Step 2: simulate the half-provisioned state — strip `keycloak_id` from
    // the users row, just like the pre-PR-#143 build left things behind.
    await db.update(users).set({ keycloakId: null }).where(eq(users.email, email));

    // Step 3: hit resend. The endpoint should now treat this as recoverable
    // and rotate the invitation token + clear `acceptedAt`.
    const resendRes = await app.inject({
      method: "POST",
      url: "/v1/public/signup/resend",
      payload: { email },
    });
    expect(resendRes.statusCode).toBe(204);

    const [invAfter] = await db
      .select({
        token: invitations.token,
        acceptedAt: invitations.acceptedAt,
      })
      .from(invitations)
      .where(eq(invitations.email, email));
    expect(invAfter?.token).not.toBe(seedToken);
    expect(invAfter?.acceptedAt).toBeNull();
  });

  // Companion to the "no Keycloak credential" recovery test above: a tenant
  // that completed verify under the credential-only build has a `keycloak_id`
  // on the user but no `keycloak_org_id` on the tenant. Without an Org the
  // user-attribute mapper has no `org_id` to emit and Keycloak login bounces
  // back with `missing_org_id`. Resend must rotate the token in this state
  // too, so the next verify call can wire the Org up.
  it("re-emits a verification token for an active tenant missing keycloak_org_id (no-org recovery)", async () => {
    const slugN = registerSlug("resend-noorg");
    const email = `admin+${slugN}@example.org`;

    await app.inject({
      method: "POST",
      url: "/v1/public/signup",
      headers: { "x-captcha-token": "test-token" },
      payload: {
        orgName: "NoOrg NGO",
        slug: slugN,
        firstName: "N",
        lastName: "O",
        email,
      },
    });
    const [invSeed] = await db
      .select({ token: invitations.token })
      .from(invitations)
      .where(eq(invitations.email, email));
    const seedToken = invSeed?.token;
    if (!seedToken) throw new Error("seed token missing");
    const verifyRes = await app.inject({
      method: "POST",
      url: "/v1/public/signup/verify",
      payload: {
        token: seedToken,
        firstName: "No",
        lastName: "Org",
        password: TEST_PASSWORD,
      },
    });
    expect(verifyRes.statusCode).toBe(201);

    // Reproduce the no-org half-state: clear keycloak_org_id on the tenant.
    // users.keycloak_id stays set — the user has a credential, just no Org.
    await db.update(tenants).set({ keycloakOrgId: null }).where(eq(tenants.slug, slugN));

    const resendRes = await app.inject({
      method: "POST",
      url: "/v1/public/signup/resend",
      payload: { email },
    });
    expect(resendRes.statusCode).toBe(204);

    const [invAfter] = await db
      .select({ token: invitations.token, acceptedAt: invitations.acceptedAt })
      .from(invitations)
      .where(eq(invitations.email, email));
    expect(invAfter?.token).not.toBe(seedToken);
    expect(invAfter?.acceptedAt).toBeNull();

    // End-to-end: drive the rotated token through verify and assert the
    // half-state actually heals (this is the QA Major #1 follow-through —
    // until now we only proved the token rotated, not that the next verify
    // landed `keycloak_org_id` on the tenant).
    const [userBefore] = await db.select().from(users).where(eq(users.email, email));
    const originalKcId = userBefore?.keycloakId;

    const completionRes = await app.inject({
      method: "POST",
      url: "/v1/public/signup/verify",
      payload: {
        token: invAfter?.token,
        firstName: "No",
        lastName: "Org-Healed",
        password: TEST_PASSWORD,
      },
    });
    expect(completionRes.statusCode).toBe(201);

    const [tenantHealed] = await db.select().from(tenants).where(eq(tenants.slug, slugN));
    expect(tenantHealed?.keycloakOrgId).toBeTruthy();

    // The user already had a keycloak_id (no-org half-state means the
    // credential was bound, only the Org was missing) — verify must REUSE
    // the existing KC user via resetPassword + setUserAttributes, not
    // create a fresh one. Same id pre/post.
    const [userAfter] = await db.select().from(users).where(eq(users.email, email));
    expect(userAfter?.keycloakId).toBe(originalKcId);
    expect(kcResetUserPassword).toHaveBeenCalledWith(originalKcId, TEST_PASSWORD);
    expect(kcSetUserAttributes).toHaveBeenCalledWith(originalKcId, {
      org_id: [tenantHealed?.id],
      role: ["org_admin"],
    });
  });

  it("does NOT re-emit a token for a fully-provisioned tenant (user already has keycloak_id)", async () => {
    const slugF = registerSlug("resend-full");
    const email = `admin+${slugF}@example.org`;
    await app.inject({
      method: "POST",
      url: "/v1/public/signup",
      headers: { "x-captcha-token": "test-token" },
      payload: {
        orgName: "Full NGO",
        slug: slugF,
        firstName: "F",
        lastName: "U",
        email,
      },
    });
    const [invSeed] = await db
      .select({ token: invitations.token })
      .from(invitations)
      .where(eq(invitations.email, email));
    const seedToken = invSeed?.token;
    if (!seedToken) throw new Error("seed token missing");
    await app.inject({
      method: "POST",
      url: "/v1/public/signup/verify",
      payload: {
        token: seedToken,
        firstName: "Full",
        lastName: "Done",
        password: TEST_PASSWORD,
      },
    });

    // Verify completed cleanly → users.keycloak_id is set. Resend must be a
    // silent 204 with no token rotation.
    const tokenBefore = (
      await db
        .select({ token: invitations.token })
        .from(invitations)
        .where(eq(invitations.email, email))
    )[0]?.token;

    const resendRes = await app.inject({
      method: "POST",
      url: "/v1/public/signup/resend",
      payload: { email },
    });
    expect(resendRes.statusCode).toBe(204);

    const tokenAfter = (
      await db
        .select({ token: invitations.token })
        .from(invitations)
        .where(eq(invitations.email, email))
    )[0]?.token;
    expect(tokenAfter).toBe(tokenBefore);
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
      payload: {
        token,
        firstName: "Alice",
        lastName: "Anderson",
        password: TEST_PASSWORD,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ data: { slug: string } }>();
    // The public response is now trimmed to just `slug` (the only field the
    // web consumes — the previous shape leaked a fresh KC user id into the
    // browser for no reason). Look the user row up by tenant + email instead.
    expect(body.data.slug).toBeTruthy();

    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(tenant?.status).toBe("active");
    expect(tenant?.verifiedAt).not.toBeNull();
    // Verify must also bind the new Keycloak Organization id onto the tenant
    // row — without it, the realm's organization-membership mapper has nothing
    // to look up and the JWT lacks the `org_id`/`organization` claims that the
    // web `/api/auth/callback` requires.
    expect(tenant?.keycloakOrgId).toBeTruthy();

    const [user] = await db
      .select()
      .from(users)
      .where(and(eq(users.orgId, tenantId), eq(users.email, email)));
    expect(user?.email).toBe(email);
    expect(user?.firstAdmin).toBe(true);
    expect(user?.provisionalUntil).not.toBeNull();
    expect(user?.role).toBe("org_admin");
    // The verify flow is required to provision a Keycloak user and bind its
    // id back to the Givernance row — without this, the post-verify Keycloak
    // login redirect dead-ends because the realm has no matching credential.
    expect(user?.keycloakId).toBeTruthy();

    const [inv] = await db
      .select({ acceptedAt: invitations.acceptedAt })
      .from(invitations)
      .where(eq(invitations.email, email));
    expect(inv?.acceptedAt).not.toBeNull();
  });

  it("provisions the Keycloak Organization, user, attributes, and member attach", async () => {
    const { tenantId, email, token } = await createSignup("verify-kc-call");
    const res = await app.inject({
      method: "POST",
      url: "/v1/public/signup/verify",
      payload: {
        token,
        firstName: "Bob",
        lastName: "Builder",
        password: TEST_PASSWORD,
      },
    });
    expect(res.statusCode).toBe(201);

    // Organization first — the user attach + attribute steps both depend on it.
    expect(kcCreateOrganization).toHaveBeenCalledTimes(1);
    const orgCall = kcCreateOrganization.mock.calls[0]?.[0];
    expect(orgCall?.attributes?.org_id).toEqual([tenantId]);

    expect(kcCreateUser).toHaveBeenCalledTimes(1);
    expect(kcCreateUser).toHaveBeenCalledWith({
      email,
      firstName: "Bob",
      lastName: "Builder",
      password: TEST_PASSWORD,
      // The verify token is the email-ownership proof — Keycloak should NOT
      // ask for another round of verification.
      emailVerified: true,
      // The user-attribute mapper turns these into the `org_id` and `role`
      // JWT claims the web callback hard-requires.
      attributes: { org_id: [tenantId], role: ["org_admin"] },
    });

    // Member attach binds the user to the org so the `organization`
    // membership claim can be emitted on subsequent logins. Assert exact
    // arguments — `(orgId, userId)` order matters and a swap would emit a
    // tenant-leakage bug that a `toHaveBeenCalledTimes` check would miss.
    const orgIdAdopted = await kcCreateOrganization.mock.results[0]?.value;
    const userIdAdopted = await kcCreateUser.mock.results[0]?.value;
    expect(kcAttachUserToOrg).toHaveBeenCalledTimes(1);
    expect(kcAttachUserToOrg).toHaveBeenCalledWith(orgIdAdopted?.id, userIdAdopted?.id);
  });

  it("recovers from a 409 on createOrganization by looking up by alias (no orphan re-create)", async () => {
    const { tenantId, token } = await createSignup("verify-org-409");

    // Simulate the recovery state: the org was created in a previous attempt
    // but the keycloak_org_id never landed on the tenant row (DB rollback /
    // network glitch). The next createOrganization 409s; verify must fall
    // back to getOrganizationByAlias. The adoption is now gated on the
    // existing org's `org_id` attribute matching the tenant — without that
    // gate, a stranger's leftover org could be silently inherited.
    kcCreateOrganization.mockRejectedValueOnce(
      new (await import("../../lib/keycloak-admin.js")).KeycloakAdminError(
        "alias taken",
        409,
        "/organizations",
      ),
    );
    const recoveredOrgId = randomUUID();
    kcGetOrganizationByAlias.mockResolvedValueOnce({
      id: recoveredOrgId,
      name: "irrelevant",
      alias: "verify-org-409",
      attributes: { org_id: [tenantId] },
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/public/signup/verify",
      payload: {
        token,
        firstName: "Org",
        lastName: "Recovered",
        password: TEST_PASSWORD,
      },
    });
    expect(res.statusCode).toBe(201);

    expect(kcGetOrganizationByAlias).toHaveBeenCalledTimes(1);
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(tenant?.keycloakOrgId).toBe(recoveredOrgId);
  });

  it("refuses to adopt an existing KC Organization whose org_id attribute belongs to a different tenant", async () => {
    const { tenantId, token } = await createSignup("verify-org-mismatch");
    const stranger = randomUUID();
    kcCreateOrganization.mockRejectedValueOnce(
      new (await import("../../lib/keycloak-admin.js")).KeycloakAdminError(
        "alias taken",
        409,
        "/organizations",
      ),
    );
    kcGetOrganizationByAlias.mockResolvedValueOnce({
      id: randomUUID(),
      name: "stranger",
      alias: "verify-org-mismatch",
      attributes: { org_id: [stranger] }, // <-- different tenant's id
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/public/signup/verify",
      payload: {
        token,
        firstName: "No",
        lastName: "Adoption",
        password: TEST_PASSWORD,
      },
    });
    // Mismatch must be hard-fail — the route surfaces 500, the verify rolls
    // back, and the tenant stays provisional. We MUST NOT silently inherit
    // a stranger's KC org.
    expect(res.statusCode).toBe(500);
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(tenant?.status).toBe("provisional");
    expect(tenant?.keycloakOrgId).toBeNull();
  });

  it("returns generic 410 (no enumeration oracle) when the email already has a Keycloak credential", async () => {
    const { tenantId, token } = await createSignup("verify-kc-exists");
    // Simulate the dangerous case the hijack guard defends against — an
    // existing realm user with this email (e.g. seeded super_admin or an
    // enterprise-tenant user provisioned before JIT). createUser must fail
    // loud (KeycloakUserExistsError); the verify endpoint must surface 410
    // generic, the tenant must stay provisional, no users row must leak.
    kcCreateUser.mockRejectedValueOnce(
      new (await import("../../lib/keycloak-admin.js")).KeycloakUserExistsError(
        "kc-existing@example.org",
      ),
    );
    const res = await app.inject({
      method: "POST",
      url: "/v1/public/signup/verify",
      payload: {
        token,
        firstName: "Existing",
        lastName: "User",
        password: TEST_PASSWORD,
      },
    });
    expect(res.statusCode).toBe(410);
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(tenant?.status).toBe("provisional");
    const userRows = await db.select().from(users).where(eq(users.orgId, tenantId));
    expect(userRows.length).toBe(0);
  });

  it("rolls back when attachUserToOrg fails (verifies the orphan KC user gap)", async () => {
    const { tenantId, token } = await createSignup("verify-attach-fail");
    kcAttachUserToOrg.mockRejectedValueOnce(new Error("attach exploded"));
    const res = await app.inject({
      method: "POST",
      url: "/v1/public/signup/verify",
      payload: {
        token,
        firstName: "Attach",
        lastName: "Fail",
        password: TEST_PASSWORD,
      },
    });
    // Today this is a known leak: createUser already succeeded by the time
    // attach blows up, so a Keycloak user with a real password is left
    // behind with no compensating delete. The DB does roll back correctly,
    // which is what this test pins down. A follow-up issue tracks adding
    // the compensating delete on the KC side.
    expect(res.statusCode).toBe(500);
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(tenant?.status).toBe("provisional");
    const userRows = await db.select().from(users).where(eq(users.orgId, tenantId));
    expect(userRows.length).toBe(0);
    // createUser DID get called (and the stub returned a fake id) — that's
    // the orphan we'd need to compensate.
    expect(kcCreateUser).toHaveBeenCalledTimes(1);
  });

  it("rejects when the password is shorter than the minimum length (validation 400)", async () => {
    const { token } = await createSignup("verify-short-pw");
    const res = await app.inject({
      method: "POST",
      url: "/v1/public/signup/verify",
      payload: {
        token,
        firstName: "P",
        lastName: "W",
        password: "short", // < 12 chars
      },
    });
    // Fastify schema rejects with 400 before the service runs — KC is never
    // contacted.
    expect(res.statusCode).toBe(400);
    expect(kcCreateUser).not.toHaveBeenCalled();
  });

  it("returns 410 when the same token is used twice", async () => {
    const { token } = await createSignup("verify-twice");
    const first = await app.inject({
      method: "POST",
      url: "/v1/public/signup/verify",
      payload: {
        token,
        firstName: "A",
        lastName: "B",
        password: TEST_PASSWORD,
      },
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: "POST",
      url: "/v1/public/signup/verify",
      payload: {
        token,
        firstName: "A",
        lastName: "B",
        password: TEST_PASSWORD,
      },
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
        password: TEST_PASSWORD,
      },
    });
    expect(res.statusCode).toBe(410);
  });

  // Recovery path companion to the resend test above: once resend has cleared
  // `acceptedAt` on a half-provisioned tenant, the second verify call must
  // upsert the existing users row (binding the new keycloak_id) instead of
  // failing on the (org_id, email) unique constraint.
  it("upserts the users row on re-verify after a recovery resend (no duplicate-row error)", async () => {
    const slugU = registerSlug("verify-upsert");
    const email = `admin+${slugU}@example.org`;

    // First signup + verify — creates the users row.
    await app.inject({
      method: "POST",
      url: "/v1/public/signup",
      headers: { "x-captcha-token": "test-token" },
      payload: {
        orgName: "Upsert NGO",
        slug: slugU,
        firstName: "U",
        lastName: "P",
        email,
      },
    });
    const [invSeed] = await db
      .select({ token: invitations.token, id: invitations.id })
      .from(invitations)
      .where(eq(invitations.email, email));
    const firstToken = invSeed?.token;
    if (!firstToken) throw new Error("seed token missing");
    await app.inject({
      method: "POST",
      url: "/v1/public/signup/verify",
      payload: {
        token: firstToken,
        firstName: "Original",
        lastName: "Owner",
        password: TEST_PASSWORD,
      },
    });

    const [originalUser] = await db.select().from(users).where(eq(users.email, email));
    expect(originalUser).toBeDefined();
    const originalId = originalUser?.id;
    const originalKeycloakId = originalUser?.keycloakId;

    // Reproduce the half-provisioned state, then resend → verify again with a
    // different name to prove the upsert took.
    await db.update(users).set({ keycloakId: null }).where(eq(users.email, email));
    await app.inject({
      method: "POST",
      url: "/v1/public/signup/resend",
      payload: { email },
    });
    const [invAfterResend] = await db
      .select({ token: invitations.token })
      .from(invitations)
      .where(eq(invitations.email, email));
    const recoveryToken = invAfterResend?.token;
    if (!recoveryToken || recoveryToken === firstToken) {
      throw new Error("recovery token was not rotated");
    }

    const recoveryRes = await app.inject({
      method: "POST",
      url: "/v1/public/signup/verify",
      payload: {
        token: recoveryToken,
        firstName: "Recovery",
        lastName: "Pass",
        password: TEST_PASSWORD,
      },
    });
    expect(recoveryRes.statusCode).toBe(201);

    // Same row id (no duplicate insert), names patched, fresh keycloak_id
    // bound, firstAdmin / provisional fields preserved.
    const userRows = await db.select().from(users).where(eq(users.email, email));
    expect(userRows.length).toBe(1);
    const u = userRows[0];
    expect(u?.id).toBe(originalId);
    expect(u?.firstName).toBe("Recovery");
    expect(u?.lastName).toBe("Pass");
    expect(u?.firstAdmin).toBe(true);
    expect(u?.keycloakId).toBeTruthy();
    expect(u?.keycloakId).not.toBe(originalKeycloakId);
  });

  it("rolls back the verify when the Keycloak admin call fails (no half-provisioned tenant)", async () => {
    const { tenantId, token } = await createSignup("verify-kc-fail");
    kcCreateUser.mockRejectedValueOnce(new Error("kc admin down"));

    let threw = false;
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/public/signup/verify",
        payload: {
          token,
          firstName: "Rolled",
          lastName: "Back",
          password: TEST_PASSWORD,
        },
      });
      // Fastify's default error handler turns the throw into a 500.
      expect(res.statusCode).toBe(500);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);

    // Tenant must remain provisional, no users row created, invitation still pending.
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(tenant?.status).toBe("provisional");
    expect(tenant?.verifiedAt).toBeNull();
    const userRows = await db.select().from(users).where(eq(users.orgId, tenantId));
    expect(userRows.length).toBe(0);
    const [invRow] = await db
      .select({ acceptedAt: invitations.acceptedAt })
      .from(invitations)
      .where(eq(invitations.orgId, tenantId));
    expect(invRow?.acceptedAt).toBeNull();
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

// ─── Regression: app-role RLS visibility on signup-verification rows ─────────
//
// The verify / resend / lookup / cleanup paths run BEFORE the request has a
// known org id, so they can't `set_config('app.current_organization_id', …)`
// before reading. Under the runtime app role (`givernance_app`, NOBYPASSRLS)
// those reads return zero rows because `invitations` and `tenant_domains`
// have FORCE RLS — every valid token would look "invalid or already used".
// This test directly probes the RLS plane to lock the behaviour in place;
// the fix is to use the owner-role `systemDb` for those system operations.
describe("RLS visibility (regression for systemDb usage)", () => {
  it("the runtime app role cannot SELECT signup invitations without org context", async () => {
    // Skip when no separate app-role connection is configured (the local test
    // setup falls back to the owner role). Locally `pnpm dev` and CI both
    // provide a `givernance_app` role; this guard keeps things forgiving.
    const appUrl = process.env.DATABASE_URL_APP_TEST;
    if (!appUrl) return;

    const { Pool } = await import("pg");
    const appPool = new Pool({ connectionString: appUrl, max: 2 });
    try {
      // Seed an invitation we can look up.
      const s = registerSlug("rls-canary");
      const [tenant] = await db
        .insert(tenants)
        .values({ name: "RLS Canary", slug: s, status: "provisional", createdVia: "self_serve" })
        .returning({ id: tenants.id });
      if (!tenant) throw new Error("seed failed");
      const token = randomUUID();
      await db.insert(invitations).values({
        orgId: tenant.id,
        email: `rls+${s}@example.org`,
        role: "org_admin",
        token,
        purpose: "signup_verification",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });

      // Same query as verifySignup — under the app role, RLS hides the row.
      const blocked = await appPool.query(
        `SELECT i.id FROM invitations i
           JOIN tenants t ON i.org_id = t.id
          WHERE i.token = $1
            AND i.purpose = 'signup_verification'
            AND t.created_via = 'self_serve'`,
        [token],
      );
      expect(blocked.rowCount).toBe(0);
    } finally {
      await appPool.end();
    }
  });
});
