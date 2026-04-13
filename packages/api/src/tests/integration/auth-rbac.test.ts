import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../../server.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await createServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

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

describe("RBAC — unauthenticated access", () => {
  it("GET /v1/constituents without token returns 401", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/constituents" });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({
      statusCode: 401,
      error: "Unauthorized",
    });
  });

  it("POST /v1/constituents without token returns 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents",
      payload: { firstName: "Test", lastName: "User", type: "donor" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({
      statusCode: 401,
      error: "Unauthorized",
    });
  });
});

describe("RBAC — authenticated access", () => {
  it("GET /v1/constituents with valid token returns 200", async () => {
    const token = app.jwt.sign({
      sub: "00000000-0000-0000-0000-000000000099",
      org_id: "00000000-0000-0000-0000-000000000001",
      realm_access: { roles: ["admin"] },
      email: "test@example.org",
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      data: expect.any(Array),
      pagination: expect.objectContaining({ page: 1 }),
    });
  });
});
