/**
 * Tests for `GET /api/auth/restore-session` (issue #296).
 *
 * The route is the server-side silent-refresh detour the proxy and the
 * impersonation-expiry interceptor redirect into now that `refresh_token`
 * is scoped to `/api/auth` and can no longer be read in the proxy. Covers:
 *   - No refresh-token cookie → 303 to /login (cookies cleared)
 *   - Happy-path refresh → 303 to the validated `return`, cookies rotated
 *   - Keycloak rejects the refresh → 303 to /login (cookies cleared)
 *   - Cross-origin / missing `return` → defaults to /dashboard
 *   - `cache-control: no-store` on every response
 */

import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const jar = new Map<string, string>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = jar.get(name);
      return value === undefined ? undefined : { value };
    },
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
    delete: (nameOrOpts: string | { name: string }) => {
      jar.delete(typeof nameOrOpts === "string" ? nameOrOpts : nameOrOpts.name);
    },
  }),
}));

const { GET } = await import("./route");

const KEYCLOAK_TOKEN_URL = "http://localhost:8080/realms/givernance/protocol/openid-connect/token";

function makeRequest(returnParam?: string): NextRequest {
  const url = new URL("http://localhost:3000/api/auth/restore-session");
  if (returnParam !== undefined) url.searchParams.set("return", returnParam);
  return { url: url.toString(), nextUrl: url } as unknown as NextRequest;
}

function location(res: Response): string {
  return res.headers.get("location") ?? "";
}

beforeEach(() => {
  jar.clear();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/auth/restore-session", () => {
  it("303s to /login (preserving return) and clears cookies when no refresh token is present", async () => {
    jar.set("givernance_jwt", "stale-jwt");
    jar.set("givernance_id_token", "stale-id");

    const res = await GET(makeRequest("/dashboard"));

    expect(res.status).toBe(303);
    expect(location(res)).toBe("http://localhost:3000/login?redirect=%2Fdashboard");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(jar.has("givernance_jwt")).toBe(false);
    expect(jar.has("givernance_id_token")).toBe(false);
  });

  it("rotates cookies and 303s to the validated return on a happy-path refresh", async () => {
    jar.set("givernance_refresh_token", "old-refresh");
    jar.set("csrf-token", "stable-csrf");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe(KEYCLOAK_TOKEN_URL);
        return new Response(
          JSON.stringify({
            access_token: "fresh-jwt",
            id_token: "fresh-id",
            refresh_token: "fresh-refresh",
            expires_in: 300,
            refresh_expires_in: 1800,
          }),
          { status: 200 },
        );
      }),
    );

    const res = await GET(makeRequest("/admin/impersonation"));

    expect(res.status).toBe(303);
    expect(location(res)).toBe("http://localhost:3000/admin/impersonation");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(jar.get("givernance_jwt")).toBe("fresh-jwt");
    expect(jar.get("givernance_id_token")).toBe("fresh-id");
    expect(jar.get("givernance_refresh_token")).toBe("fresh-refresh");
    // CSRF preserved across rotation (mirrors /api/auth/refresh).
    expect(jar.get("csrf-token")).toBe("stable-csrf");
  });

  it("303s to /login and clears cookies when Keycloak rejects the refresh", async () => {
    jar.set("givernance_refresh_token", "revoked");
    jar.set("givernance_jwt", "old-jwt");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })),
    );

    const res = await GET(makeRequest("/settings"));

    expect(res.status).toBe(303);
    expect(location(res)).toBe("http://localhost:3000/login?redirect=%2Fsettings");
    expect(jar.has("givernance_jwt")).toBe(false);
    expect(jar.has("givernance_refresh_token")).toBe(false);
  });

  it("defaults a cross-origin or missing return to /dashboard (anti-open-redirect)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ access_token: "fresh-jwt", expires_in: 300 }), {
            status: 200,
          }),
      ),
    );

    jar.set("givernance_refresh_token", "good-refresh");
    const evil = await GET(makeRequest("https://evil.example.com/steal"));
    expect(location(evil)).toBe("http://localhost:3000/dashboard");

    jar.clear();
    jar.set("givernance_refresh_token", "good-refresh");
    const none = await GET(makeRequest());
    expect(location(none)).toBe("http://localhost:3000/dashboard");
  });
});
