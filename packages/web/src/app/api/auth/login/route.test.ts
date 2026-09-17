/**
 * Tests for `GET /api/auth/login` — the `return_to` round-trip cookie
 * (issue #250 step-up, issue #613 post-expiry return URL).
 *
 * The cookie jar mock is PATH-AWARE and strict: the string form of
 * `delete` only clears the `Path=/` cookie, like a real browser. That is
 * the whole point — `oidc_return_to` lives at `Path=/api/auth`, and the
 * bare `jar.delete(name)` the route used to call never cleared it.
 */

import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const store = new Map<string, string>();
const key = (name: string, path: string) => `${name} ${path}`;

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      for (const [k, value] of store) if (k.startsWith(`${name} `)) return { value };
      return undefined;
    },
    set: (name: string, value: string, opts?: { path?: string }) => {
      store.set(key(name, opts?.path ?? "/"), value);
    },
    delete: (nameOrOpts: string | { name: string; path?: string }) => {
      if (typeof nameOrOpts === "string") store.delete(key(nameOrOpts, "/"));
      else store.delete(key(nameOrOpts.name, nameOrOpts.path ?? "/"));
    },
  }),
}));

const { GET } = await import("./route");

function makeRequest(query = ""): NextRequest {
  return {
    url: `http://localhost:3000/api/auth/login${query}`,
    headers: new Headers({ host: "localhost:3000" }),
  } as unknown as NextRequest;
}

beforeEach(() => {
  store.clear();
});

describe("GET /api/auth/login — return_to cookie", () => {
  it("clears a stale return_to cookie at its real path on a plain login", async () => {
    // Abandoned step-up from a few minutes ago.
    store.set(key("oidc_return_to", "/api/auth"), "/admin/impersonation/new");

    const res = await GET(makeRequest());

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/protocol/openid-connect/auth?");
    expect(store.has(key("oidc_return_to", "/api/auth"))).toBe(false);
  });

  it("persists a same-origin return_to at Path=/api/auth", async () => {
    await GET(makeRequest("?return_to=%2Fconstituents%3Fpage%3D2"));

    expect(store.get(key("oidc_return_to", "/api/auth"))).toBe("/constituents?page=2");
    expect(store.has(key("oidc_return_to", "/"))).toBe(false);
  });

  it("replaces a stale return_to with the new one", async () => {
    store.set(key("oidc_return_to", "/api/auth"), "/admin/impersonation/new");

    await GET(makeRequest("?return_to=%2Fdonations"));

    expect(store.get(key("oidc_return_to", "/api/auth"))).toBe("/donations");
  });

  it.each([
    "https://evil.example/",
    "//evil.example/",
    "dashboard",
  ])("rejects the cross-origin / malformed return_to %s and clears the stale one", async (raw) => {
    store.set(key("oidc_return_to", "/api/auth"), "/admin/impersonation/new");

    await GET(makeRequest(`?return_to=${encodeURIComponent(raw)}`));

    expect(store.has(key("oidc_return_to", "/api/auth"))).toBe(false);
  });
});
