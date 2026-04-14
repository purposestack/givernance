import { funds } from "@givernance/shared/schema";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";
import { createServer } from "../../server.js";

let app: FastifyInstance;

const ORG_A = "00000000-0000-0000-0000-000000000001";
const ORG_B = "00000000-0000-0000-0000-000000000002";
const USER_A = "00000000-0000-0000-0000-000000000099";
const USER_B = "00000000-0000-0000-0000-000000000098";

function signToken(app: FastifyInstance, claims: Record<string, unknown> = {}) {
  return app.jwt.sign({
    sub: USER_A,
    org_id: ORG_A,
    realm_access: { roles: ["admin"] },
    email: "user-a@example.org",
    role: "org_admin",
    ...claims,
  });
}

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

let constituentIdA: string;
let fundIdA: string;

beforeAll(async () => {
  app = await createServer();
  await app.ready();

  // Ensure test tenants exist
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug) VALUES (${ORG_A}, 'Org A', 'test-org-a') ON CONFLICT (id) DO NOTHING`,
  );
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug) VALUES (${ORG_B}, 'Org B', 'test-org-b') ON CONFLICT (id) DO NOTHING`,
  );

  // Create constituents for donation tests
  const tokenA = signToken(app);
  const res1 = await app.inject({
    method: "POST",
    url: "/v1/constituents?force=true",
    headers: authHeader(tokenA),
    payload: { firstName: "Donor", lastName: "Alpha", type: "donor" },
  });
  constituentIdA = res1.json<{ data: { id: string } }>().data.id;

  // Create a fund for allocation tests
  await db.execute(sql`SELECT set_config('app.current_org_id', ${ORG_A}, false)`);
  const [fund] = await db
    .insert(funds)
    .values({ orgId: ORG_A, name: "General Fund", type: "unrestricted" })
    .returning();
  // biome-ignore lint/style/noNonNullAssertion: test setup — insert always returns a row
  fundIdA = fund!.id;
});

afterAll(async () => {
  await app.close();
});

// ─── Donations CRUD ─────────────────────────────────────────────────────────

describe("Donations CRUD", () => {
  let donationId: string;

  it("POST /v1/donations creates a donation", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/donations",
      headers: authHeader(tokenA),
      payload: {
        constituentId: constituentIdA,
        amountCents: 10000,
        currency: "EUR",
        paymentMethod: "check",
        paymentRef: "CHK-001",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ data: { id: string; amountCents: number } }>();
    expect(body.data).toHaveProperty("id");
    expect(body.data.amountCents).toBe(10000);
    donationId = body.data.id;
  });

  it("POST /v1/donations creates a donation with allocations", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/donations",
      headers: authHeader(tokenA),
      payload: {
        constituentId: constituentIdA,
        amountCents: 5000,
        allocations: [{ fundId: fundIdA, amountCents: 5000 }],
      },
    });

    expect(res.statusCode).toBe(201);
  });

  it("GET /v1/donations lists donations", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/donations",
      headers: authHeader(tokenA),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: unknown[]; pagination: { total: number } }>();
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    expect(body.pagination.total).toBeGreaterThanOrEqual(2);
  });

  it("GET /v1/donations filters by constituentId", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/donations?constituentId=${constituentIdA}`,
      headers: authHeader(tokenA),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { constituentId: string }[] }>();
    for (const d of body.data) {
      expect(d.constituentId).toBe(constituentIdA);
    }
  });

  it("GET /v1/donations filters by amountMin/amountMax", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/donations?amountMin=7000&amountMax=15000",
      headers: authHeader(tokenA),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { amountCents: number }[] }>();
    for (const d of body.data) {
      expect(d.amountCents).toBeGreaterThanOrEqual(7000);
      expect(d.amountCents).toBeLessThanOrEqual(15000);
    }
  });

  it("GET /v1/donations/:id returns donation with constituent and allocations", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/donations/${donationId}`,
      headers: authHeader(tokenA),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        id: string;
        constituent: { firstName: string };
        allocations: unknown[];
      };
    }>();
    expect(body.data.id).toBe(donationId);
    expect(body.data.constituent).toBeTruthy();
    expect(body.data.constituent.firstName).toBe("Donor");
    expect(Array.isArray(body.data.allocations)).toBe(true);
  });

  it("GET /v1/donations/:id returns 404 for non-existent ID", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/donations/00000000-0000-0000-0000-ffffffffffff",
      headers: authHeader(tokenA),
    });

    expect(res.statusCode).toBe(404);
  });

  it("DonationCreated outbox event is emitted", async () => {
    const rows = await db.execute(
      sql`SELECT type, payload FROM outbox_events
          WHERE tenant_id = ${ORG_A} AND type = 'donation.created'
          ORDER BY created_at DESC LIMIT 1`,
    );

    expect(rows.rows.length).toBe(1);
    expect((rows.rows[0] as { type: string }).type).toBe("donation.created");
  });
});

// ─── Donations RLS Tenant Isolation ─────────────────────────────────────────

describe("Donations RLS tenant isolation", () => {
  let donationInA: string;

  beforeAll(async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/donations",
      headers: authHeader(tokenA),
      payload: {
        constituentId: constituentIdA,
        amountCents: 2500,
        paymentMethod: "cash",
      },
    });
    donationInA = res.json<{ data: { id: string } }>().data.id;
  });

  it("Tenant B cannot GET a donation from Tenant A", async () => {
    const tokenB = signToken(app, { sub: USER_B, org_id: ORG_B, email: "user-b@example.org" });
    const res = await app.inject({
      method: "GET",
      url: `/v1/donations/${donationInA}`,
      headers: authHeader(tokenB),
    });

    expect(res.statusCode).toBe(404);
  });

  it("Tenant B list does not include Tenant A donations", async () => {
    const tokenB = signToken(app, { sub: USER_B, org_id: ORG_B, email: "user-b@example.org" });
    const res = await app.inject({
      method: "GET",
      url: "/v1/donations",
      headers: authHeader(tokenB),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { id: string }[] }>();
    const ids = body.data.map((d) => d.id);
    expect(ids).not.toContain(donationInA);
  });
});

// ─── Donations Unauthenticated Access ───────────────────────────────────────

describe("Donations unauthenticated access", () => {
  it("GET /v1/donations without token returns 401", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/donations" });
    expect(res.statusCode).toBe(401);
  });

  it("POST /v1/donations without token returns 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/donations",
      payload: { constituentId: constituentIdA, amountCents: 100 },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ─── Pledges ────────────────────────────────────────────────────────────────

describe("Pledges CRUD", () => {
  let pledgeId: string;

  it("POST /v1/pledges creates a monthly pledge with 12 installments", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/pledges",
      headers: authHeader(tokenA),
      payload: {
        constituentId: constituentIdA,
        amountCents: 5000,
        frequency: "monthly",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ data: { id: string; frequency: string } }>();
    expect(body.data).toHaveProperty("id");
    expect(body.data.frequency).toBe("monthly");
    pledgeId = body.data.id;
  });

  it("GET /v1/pledges/:id/installments returns 12 installments for monthly pledge", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/pledges/${pledgeId}/installments`,
      headers: authHeader(tokenA),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { id: string; expectedAt: string }[] }>();
    expect(body.data.length).toBe(12);
  });

  it("POST /v1/pledges creates a yearly pledge with 1 installment", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/pledges",
      headers: authHeader(tokenA),
      payload: {
        constituentId: constituentIdA,
        amountCents: 60000,
        frequency: "yearly",
      },
    });

    expect(res.statusCode).toBe(201);
    const yearlyPledgeId = res.json<{ data: { id: string } }>().data.id;

    const installRes = await app.inject({
      method: "GET",
      url: `/v1/pledges/${yearlyPledgeId}/installments`,
      headers: authHeader(tokenA),
    });

    expect(installRes.statusCode).toBe(200);
    const installBody = installRes.json<{ data: unknown[] }>();
    expect(installBody.data.length).toBe(1);
  });

  it("GET /v1/pledges/:id/installments returns 404 for non-existent pledge", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/pledges/00000000-0000-0000-0000-ffffffffffff/installments",
      headers: authHeader(tokenA),
    });

    expect(res.statusCode).toBe(404);
  });

  it("PledgeCreated outbox event is emitted", async () => {
    const rows = await db.execute(
      sql`SELECT type FROM outbox_events
          WHERE tenant_id = ${ORG_A} AND type = 'pledge.created'
          ORDER BY created_at DESC LIMIT 1`,
    );

    expect(rows.rows.length).toBe(1);
  });
});

// ─── Pledges RLS Tenant Isolation ───────────────────────────────────────────

describe("Pledges RLS tenant isolation", () => {
  let pledgeInA: string;

  beforeAll(async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/pledges",
      headers: authHeader(tokenA),
      payload: {
        constituentId: constituentIdA,
        amountCents: 3000,
        frequency: "monthly",
      },
    });
    pledgeInA = res.json<{ data: { id: string } }>().data.id;
  });

  it("Tenant B cannot GET installments for Tenant A pledge", async () => {
    const tokenB = signToken(app, { sub: USER_B, org_id: ORG_B, email: "user-b@example.org" });
    const res = await app.inject({
      method: "GET",
      url: `/v1/pledges/${pledgeInA}/installments`,
      headers: authHeader(tokenB),
    });

    expect(res.statusCode).toBe(404);
  });
});

// ─── Pledges Unauthenticated Access ─────────────────────────────────────────

describe("Pledges unauthenticated access", () => {
  it("POST /v1/pledges without token returns 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/pledges",
      payload: { constituentId: constituentIdA, amountCents: 100, frequency: "monthly" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("GET /v1/pledges/:id/installments without token returns 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/pledges/00000000-0000-0000-0000-000000000001/installments",
    });
    expect(res.statusCode).toBe(401);
  });
});
