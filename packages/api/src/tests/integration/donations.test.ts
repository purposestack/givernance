import { funds } from "@givernance/shared/schema";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, withTenantContext } from "../../lib/db.js";
import { createServer } from "../../server.js";
import { authHeader, ensureTestTenants, ORG_A, signToken, signTokenB } from "../helpers/auth.js";

let app: FastifyInstance;

let constituentIdA: string;
let constituentIdB: string;
let fundIdA: string;

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();

  // Create constituent in Tenant A
  const tokenA = signToken(app);
  const res1 = await app.inject({
    method: "POST",
    url: "/v1/constituents?force=true",
    headers: authHeader(tokenA),
    payload: { firstName: "Donor", lastName: "Alpha", type: "donor" },
  });
  constituentIdA = res1.json<{ data: { id: string } }>().data.id;

  // Create constituent in Tenant B (for cross-tenant FK test)
  const tokenB = signTokenB(app);
  const res2 = await app.inject({
    method: "POST",
    url: "/v1/constituents?force=true",
    headers: authHeader(tokenB),
    payload: { firstName: "Donor", lastName: "Beta", type: "donor" },
  });
  constituentIdB = res2.json<{ data: { id: string } }>().data.id;

  // Create a fund for allocation tests (use withTenantContext instead of session-scoped set_config)
  await withTenantContext(ORG_A, async (tx) => {
    const [fund] = await tx
      .insert(funds)
      .values({ orgId: ORG_A, name: "General Fund", type: "unrestricted" })
      .returning();
    // biome-ignore lint/style/noNonNullAssertion: test setup — insert always returns a row
    fundIdA = fund!.id;
  });
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
        paymentRef: `CHK-${Date.now()}-${Math.random()}`,
      },
    });

    if (res.statusCode !== 201) console.log(res.json());
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

    if (res.statusCode !== 201) console.log(res.json());
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

  it("GET /v1/donations/:id returns 400 for invalid UUID", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/donations/not-a-valid-uuid",
      headers: authHeader(tokenA),
    });

    expect(res.statusCode).toBe(400);
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
    const tokenB = signTokenB(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/donations/${donationInA}`,
      headers: authHeader(tokenB),
    });

    expect(res.statusCode).toBe(404);
  });

  it("Tenant B list does not include Tenant A donations", async () => {
    const tokenB = signTokenB(app);
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

// ─── Cross-tenant FK rejection (QA #2) ─────────────────────────────────────

describe("Donations cross-tenant FK rejection", () => {
  it("POST /v1/donations rejects constituentId from another tenant", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/donations",
      headers: authHeader(tokenA),
      payload: {
        constituentId: constituentIdB,
        amountCents: 1000,
        currency: "EUR",
      },
    });

    // constituentIdB belongs to Tenant B — Tenant A must not reference it
    expect(res.statusCode).toBe(404);
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

    if (res.statusCode !== 201) console.log(res.json());
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

    if (res.statusCode !== 201) console.log(res.json());
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

  it("GET /v1/pledges/:id/installments returns 400 for invalid UUID", async () => {
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/pledges/not-a-valid-uuid/installments",
      headers: authHeader(tokenA),
    });

    expect(res.statusCode).toBe(400);
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
    const tokenB = signTokenB(app);
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
