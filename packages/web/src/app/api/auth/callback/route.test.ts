/**
 * Tests for `GET /api/auth/callback` — `return_to` cookie consumption
 * (issue #613).
 *
 * `oidc_return_to` is set at `Path=/api/auth`; the callback used to delete
 * it with the default `Path=/`, so it survived and redirected the NEXT
 * login to a stale target. The jar mock is path-aware and strict (string
 * `delete` = `Path=/` only) so that regression is actually observable.
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

const verifyKeycloakJwtMock = vi.fn();
vi.mock("@/lib/auth/verify-keycloak-jwt", () => ({
  verifyKeycloakJwt: (token: string) => verifyKeycloakJwtMock(token),
}));

const { GET } = await import("./route");

function makeRequest(query: string): NextRequest {
  const url = new URL(`http://localhost:3000/api/auth/callback${query}`);
  return { url: url.toString(), nextUrl: url } as unknown as NextRequest;
}

function seedFlowCookies(returnTo?: string) {
  store.set(key("oidc_state", "/"), "state-1");
  store.set(key("oidc_code_verifier", "/"), "verifier-1");
  store.set(key("oidc_nonce", "/"), "nonce-1");
  if (returnTo) store.set(key("oidc_return_to", "/api/auth"), returnTo);
}

beforeEach(() => {
  store.clear();
  verifyKeycloakJwtMock.mockReset();
  vi.unstubAllGlobals();
});

describe("GET /api/auth/callback — return_to cookie", () => {
  it("lands on return_to and expires the cookie at Path=/api/auth on success", async () => {
    seedFlowCookies("/constituents?page=2");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: "access",
              id_token: "id",
              refresh_token: "refresh",
              expires_in: 300,
              refresh_expires_in: 1800,
            }),
            { status: 200 },
          ),
      ),
    );
    verifyKeycloakJwtMock.mockResolvedValue({ sub: "u1", org_id: "org-1" });

    const res = await GET(makeRequest("?code=abc&state=state-1"));

    expect(res.headers.get("location")).toBe("http://localhost:3000/constituents?page=2");
    expect(store.get(key("givernance_jwt", "/"))).toBe("access");
    expect(store.has(key("oidc_return_to", "/api/auth"))).toBe(false);
    expect(store.has(key("oidc_state", "/"))).toBe(false);
  });

  it("expires the cookie on the error path too", async () => {
    seedFlowCookies("/admin/impersonation/new");

    const res = await GET(makeRequest("?error=access_denied"));

    expect(res.headers.get("location")).toContain("/login?error=");
    expect(store.has(key("oidc_return_to", "/api/auth"))).toBe(false);
  });

  it("falls back to /select-organization when no return_to cookie is present", async () => {
    seedFlowCookies();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ access_token: "access" }), { status: 200 })),
    );
    verifyKeycloakJwtMock.mockResolvedValue({ sub: "u1", org_id: "org-1" });

    const res = await GET(makeRequest("?code=abc&state=state-1"));

    expect(res.headers.get("location")).toBe("http://localhost:3000/select-organization");
  });
});
