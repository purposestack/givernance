import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";
import { createServer } from "../../server.js";
import { signToken } from "../helpers/auth.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await createServer();
  await app.ready();

  await db.execute(sql`
    INSERT INTO tenants (id, name, slug, status, created_via)
    VALUES ('00000000-0000-0000-0000-000000000999', 'Test Disputed Org', 'disputed-org', 'active', 'enterprise')
    ON CONFLICT DO NOTHING
  `);

  await db.execute(sql`
    INSERT INTO tenant_domains (id, org_id, domain, state, dns_txt_value)
    VALUES ('00000000-0000-0000-0000-000000000998', '00000000-0000-0000-0000-000000000999', 'test-dispute.com', 'verified', 'gv_abc123def456ghi789jkl012mno345pqr678stu901')
    ON CONFLICT DO NOTHING
  `);
});

afterAll(async () => {
  await app.close();
});

import type { DomainDisputeRow } from "../../modules/disputes/service.js";

describe("Domain Disputes", () => {
  it("POST /v1/public/signup/dispute returns 404 if domain not claimed", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/public/signup/dispute",
      headers: { "x-forwarded-for": "10.0.0.1" },
      payload: {
        email: "claimer@unclaimed.com",
        firstName: "Claimer",
        lastName: "One",
        reason: "I own this",
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it("POST /v1/public/signup/dispute creates dispute if domain claimed", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/public/signup/dispute",
      headers: { "x-forwarded-for": "10.0.0.2" },
      payload: {
        email: "claimer2@test-dispute.com",
        firstName: "Claimer",
        lastName: "Two",
        reason: "I own this domain",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.disputeId).toBeDefined();
  });

  it("GET /v1/admin/domain-disputes lists open disputes for superadmin", async () => {
    const token = signToken(app, {
      sub: "11111111-1111-1111-1111-111111111111",
      realm_access: { roles: ["super_admin"] },
    });
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/domain-disputes?open=true",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.length).toBeGreaterThan(0);
    expect(
      body.data.find((d: DomainDisputeRow) => d.claimerEmail === "claimer2@test-dispute.com"),
    ).toBeDefined();
  });
});
