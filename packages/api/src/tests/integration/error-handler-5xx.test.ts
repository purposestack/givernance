/**
 * Issue #611 item 1 — the global error handler must never reflect a 5xx
 * error message to the client. drizzle-orm wraps pg errors as
 * `Failed query: <sql>\nparams: <values>`, so echoing `error.message` leaks
 * table/column names and bound PII.
 */

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../../server.js";

let app: FastifyInstance;

const LEAKY_MESSAGE =
  'Failed query: select "secret_column" from "users" where "email" = $1\nparams: donor@example.org';

beforeAll(async () => {
  app = await createServer();
  // Test-only routes — registered before `ready()` so they inherit the
  // global error handler exactly like a production route.
  app.get("/__test/boom", async () => {
    throw new Error(LEAKY_MESSAGE);
  });
  app.get("/__test/teapot", async () => {
    throw Object.assign(new Error("I am a teapot"), { statusCode: 418 });
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("global error handler (issue #611)", () => {
  it("returns a fixed problem body for unhandled errors — no SQL, no params", async () => {
    const res = await app.inject({ method: "GET", url: "/__test/boom" });

    expect(res.statusCode).toBe(500);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(res.json()).toEqual({
      type: "https://httpproblems.com/http-status/500",
      title: "Internal Server Error",
      status: 500,
      detail: "An unexpected error occurred",
    });
    expect(res.body).not.toContain("Failed query");
    expect(res.body).not.toContain("secret_column");
    expect(res.body).not.toContain("donor@example.org");
  });

  it("still echoes the message for < 500 errors", async () => {
    const res = await app.inject({ method: "GET", url: "/__test/teapot" });

    expect(res.statusCode).toBe(418);
    expect(res.json().detail).toBe("I am a teapot");
  });
});
