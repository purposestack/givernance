/**
 * Smoke tests — health check and tenant creation.
 * Run with: pnpm test
 */

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mockTenant = {
  id: "aaaaaaaa-0000-0000-0000-000000000001",
  name: "Test Org",
  slug: "test-org",
  plan: "starter",
  status: "active",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

// Mock DB module before importing the server — Vitest hoists vi.mock() calls.
vi.mock("../../lib/db.js", () => {
  const insertChain = {
    values: vi.fn(() => ({
      returning: vi.fn().mockResolvedValue([mockTenant]),
    })),
  };
  const selectChain = {
    from: vi.fn(() => ({
      where: vi.fn().mockResolvedValue([]),
      orderBy: vi.fn(() => ({ limit: vi.fn(() => ({ offset: vi.fn().mockResolvedValue([]) })) })),
    })),
  };
  return {
    db: {
      execute: vi.fn().mockResolvedValue([]),
      insert: vi.fn(() => insertChain),
      select: vi.fn(() => selectChain),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([]),
        })),
      })),
      delete: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([]),
        })),
      })),
      // Support db.transaction(async (tx) => ...) by passing the same mock as tx
      transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          insert: vi.fn(() => insertChain),
          select: vi.fn(() => selectChain),
        };
        return fn(tx);
      }),
    },
  };
});

// Import server after mocks are registered
import { createServer } from "../../server.js";

describe("GET /healthz", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns 200 with status ok", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});

describe("POST /v1/tenants", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env["ADMIN_SECRET"] = "test-admin-secret";
    app = await createServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns 401 without admin secret", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tenants",
      payload: { name: "Test", slug: "test" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("creates a tenant with valid admin secret and returns 201", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tenants",
      headers: { "x-admin-secret": "test-admin-secret" },
      payload: { name: "Test Org", slug: "test-org" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ data: { id: string; name: string } }>();
    expect(body.data).toHaveProperty("id");
    expect(body.data.name).toBe("Test Org");
  });
});
