/**
 * Integration tests for the self-serve onboarding endpoints introduced in
 * #40 PR-A4.
 *
 * Covers:
 * - Unauthenticated access is denied
 * - GET /v1/tenants/me falls back to the `users.keycloak_id` lookup when the
 *   JWT carries no `org_id`
 * - POST /v1/tenants/me/onboarding updates an existing tenant
 * - POST /v1/tenants/me/onboarding bootstraps a tenant + users row when the
 *   caller has no tenant yet (seeded super_admin scenario)
 * - POST /v1/tenants/me/onboarding/complete sets onboarding_completed_at and
 *   is idempotent
 */

import { randomUUID } from "node:crypto";
import { outboxEvents, tenants, users } from "@givernance/shared/schema";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";
import { createServer } from "../../server.js";
import { authHeader, ensureTestTenants, ORG_A, signToken } from "../helpers/auth.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  // Reset Org A onboarding state so update/complete tests start from scratch.
  await db.execute(sql`
    UPDATE tenants SET
      country = NULL,
      legal_type = NULL,
      currency = 'EUR',
      registration_number = NULL,
      onboarding_completed_at = NULL
    WHERE id = ${ORG_A}
  `);
  // Clear prior onboarding outbox events so each test asserts on its own
  // emission. Scoped to onboarding event types so we don't interfere with
  // donations/campaigns tests running in parallel against the same tenant.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_organization_id', ${ORG_A}, true)`);
    await tx.execute(sql`
      DELETE FROM outbox_events
      WHERE tenant_id = ${ORG_A}
        AND type IN ('tenant.onboarding_updated', 'tenant.onboarding_completed', 'tenant.created')
    `);
  });
});

describe("Onboarding endpoints — auth gate", () => {
  it("GET /v1/tenants/me without token returns 401", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/tenants/me" });
    expect(res.statusCode).toBe(401);
  });

  it("POST /v1/tenants/me/onboarding without token returns 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tenants/me/onboarding",
      payload: { name: "X", country: "FR", legalType: "asso1901", currency: "EUR" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("POST /v1/tenants/me/onboarding/complete without token returns 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tenants/me/onboarding/complete",
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /v1/tenants/me", () => {
  it("returns the caller's tenant when org_id is in the JWT", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/tenants/me",
      headers: authHeader(signToken(app)),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { id: string; currency: string } }>();
    expect(body.data.id).toBe(ORG_A);
    expect(body.data.currency).toBe("EUR");
  });

  it("returns 404 when the JWT has no org_id and no DB users row", async () => {
    const unknownSub = randomUUID();
    const token = app.jwt.sign({
      sub: unknownSub,
      org_id: undefined,
      email: "stranger@example.org",
      realm_access: { roles: ["super_admin"] },
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/tenants/me",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(404);
  });

  it("falls back to users.keycloak_id lookup when the JWT has no org_id", async () => {
    const keycloakSub = randomUUID();
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_organization_id', ${ORG_A}, true)`);
      await tx.insert(users).values({
        orgId: ORG_A,
        email: `${keycloakSub}@example.org`,
        firstName: "Kai",
        lastName: "Lookup",
        role: "org_admin",
        keycloakId: keycloakSub,
      });
    });

    const token = app.jwt.sign({
      sub: keycloakSub,
      email: `${keycloakSub}@example.org`,
      realm_access: { roles: [] },
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/tenants/me",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { id: string } }>().data.id).toBe(ORG_A);

    // cleanup
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_organization_id', ${ORG_A}, true)`);
      await tx.delete(users).where(eq(users.keycloakId, keycloakSub));
    });
  });
});

describe("POST /v1/tenants/me/onboarding — update path", () => {
  it("persists Step 1 fields on an existing tenant", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tenants/me/onboarding",
      headers: authHeader(signToken(app)),
      payload: {
        name: "Solidarité Méditerranée",
        country: "FR",
        legalType: "asso1901",
        currency: "EUR",
        registrationNumber: "W061234567",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        id: string;
        name: string;
        country: string;
        legalType: string;
        currency: string;
        registrationNumber: string | null;
        onboardingCompletedAt: string | null;
      };
    }>();
    expect(body.data.id).toBe(ORG_A);
    expect(body.data.name).toBe("Solidarité Méditerranée");
    expect(body.data.country).toBe("FR");
    expect(body.data.legalType).toBe("asso1901");
    expect(body.data.registrationNumber).toBe("W061234567");
    expect(body.data.onboardingCompletedAt).toBeNull();
  });

  it("rejects invalid country codes with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tenants/me/onboarding",
      headers: authHeader(signToken(app)),
      payload: {
        name: "Bad",
        country: "ZZ",
        legalType: "asso1901",
        currency: "EUR",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects invalid legalType with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tenants/me/onboarding",
      headers: authHeader(signToken(app)),
      payload: {
        name: "Bad",
        country: "FR",
        legalType: "not_a_real_type",
        currency: "EUR",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects invalid currency with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tenants/me/onboarding",
      headers: authHeader(signToken(app)),
      payload: {
        name: "Bad",
        country: "FR",
        legalType: "asso1901",
        currency: "XYZ",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("emits a tenant.onboarding_updated outbox event", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/tenants/me/onboarding",
      headers: authHeader(signToken(app)),
      payload: {
        name: "Event Test Org",
        country: "DE",
        legalType: "ong",
        currency: "EUR",
      },
    });
    const events = await db
      .select()
      .from(outboxEvents)
      .where(
        and(eq(outboxEvents.tenantId, ORG_A), eq(outboxEvents.type, "tenant.onboarding_updated")),
      );
    expect(events).toHaveLength(1);
    expect((events[0]?.payload as { name?: string } | undefined)?.name).toBe("Event Test Org");
  });
});

describe("POST /v1/tenants/me/onboarding — bootstrap path", () => {
  it("creates a fresh tenant + users row when the caller has none", async () => {
    const keycloakSub = randomUUID();
    const token = app.jwt.sign({
      sub: keycloakSub,
      email: `${keycloakSub}@example.org`,
      realm_access: { roles: ["super_admin"] },
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/tenants/me/onboarding",
      headers: authHeader(token),
      payload: {
        name: "Fresh Org",
        country: "BE",
        legalType: "asbl",
        currency: "EUR",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ data: { id: string; slug: string } }>();
    expect(body.data.slug).toMatch(/^fresh-org-[0-9a-f]+$/);

    // users row created, linked by keycloak_id
    const [userRow] = await db.select().from(users).where(eq(users.keycloakId, keycloakSub));
    expect(userRow).toBeDefined();
    expect(userRow?.orgId).toBe(body.data.id);
    expect(userRow?.role).toBe("org_admin");

    // Subsequent GET /v1/tenants/me resolves the tenant via the users row
    const getRes = await app.inject({
      method: "GET",
      url: "/v1/tenants/me",
      headers: authHeader(token),
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json<{ data: { id: string } }>().data.id).toBe(body.data.id);
  });
});

describe("POST /v1/tenants/me/onboarding/complete", () => {
  it("returns 409 if the tenant has no Step 1 fields set yet", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tenants/me/onboarding/complete",
      headers: authHeader(signToken(app)),
    });
    expect(res.statusCode).toBe(409);
  });

  it("marks the tenant completed once Step 1 is saved", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/tenants/me/onboarding",
      headers: authHeader(signToken(app)),
      payload: {
        name: "Org A",
        country: "FR",
        legalType: "asso1901",
        currency: "EUR",
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/tenants/me/onboarding/complete",
      headers: authHeader(signToken(app)),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { onboardingCompletedAt: string | null } }>();
    expect(body.data.onboardingCompletedAt).not.toBeNull();

    // DB state assertion — the response shape is correct AND the row was
    // actually updated.
    const [row] = await db.select().from(tenants).where(eq(tenants.id, ORG_A));
    expect(row?.onboardingCompletedAt).not.toBeNull();
    expect(row?.onboardingCompletedAt?.toISOString()).toBe(body.data.onboardingCompletedAt);

    // Outbox event emitted.
    const events = await db
      .select()
      .from(outboxEvents)
      .where(
        and(eq(outboxEvents.tenantId, ORG_A), eq(outboxEvents.type, "tenant.onboarding_completed")),
      );
    expect(events).toHaveLength(1);

    // idempotent — a second call returns 200 and does not move the timestamp back
    const firstStamp = body.data.onboardingCompletedAt;
    const again = await app.inject({
      method: "POST",
      url: "/v1/tenants/me/onboarding/complete",
      headers: authHeader(signToken(app)),
    });
    expect(again.statusCode).toBe(200);
    expect(
      again.json<{ data: { onboardingCompletedAt: string | null } }>().data.onboardingCompletedAt,
    ).toBe(firstStamp);
  });
});
