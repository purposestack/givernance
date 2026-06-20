/**
 * Tests for `/api/auth/refresh` (issue #76 / PR-3 — silent rotation).
 *
 * Covers the six observable branches of the route:
 *   - No refresh-token cookie → 401 + cookies cleared
 *   - Keycloak 200 with full payload → 200 + cookies rotated (incl. CSRF preserved)
 *   - Keycloak 200 without refresh_token → 200 + refresh cookie NOT rotated
 *   - Keycloak 4xx invalid_grant → 401 + cookies cleared
 *   - Network error → 503 + cookies NOT cleared (intentional — session may
 *     still be valid; client retries)
 *   - Keycloak 200 with no access_token → 401 + cookies cleared
 *
 * Also asserts `cache-control: no-store` on every response.
 */

import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `server-only` throws at import time outside a server context. Stub it
// before the route module loads so the test environment doesn't reject
// the `@/lib/auth/keycloak` import chain.
vi.mock("server-only", () => ({}));

// `next/headers`'s `cookies()` is async and only valid in server contexts.
// Mock with an in-memory map so the route can read/write without touching
// the Next.js request context. Each test resets the jar before running.
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
    // Next's `cookies().delete` accepts a name or `{ name, path }`; the
    // scoped session cookies (issue #296) are deleted via the object form.
    delete: (nameOrOpts: string | { name: string }) => {
      jar.delete(typeof nameOrOpts === "string" ? nameOrOpts : nameOrOpts.name);
    },
  }),
}));

// Import the route AFTER the mocks so the module picks them up.
const { POST } = await import("./route");

const KEYCLOAK_TOKEN_URL = "http://localhost:8080/realms/givernance/protocol/openid-connect/token";

function makeRequest(): NextRequest {
  // The route only awaits its own cookies(); it never reads anything off
  // the NextRequest object, so a dummy is fine.
  return {} as NextRequest;
}

beforeEach(() => {
  jar.clear();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/auth/refresh", () => {
  it("401s with cookies cleared when no refresh-token cookie is present", async () => {
    jar.set("givernance_jwt", "stale-jwt");
    jar.set("givernance_id_token", "stale-id-token");
    jar.set("csrf-token", "stale-csrf");

    const res = await POST(makeRequest());
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(401);
    expect(body.error).toBe("no_refresh_token");
    expect(res.headers.get("cache-control")).toBe("no-store");
    // All session cookies cleared.
    expect(jar.has("givernance_jwt")).toBe(false);
    expect(jar.has("givernance_id_token")).toBe(false);
    expect(jar.has("givernance_refresh_token")).toBe(false);
    expect(jar.has("csrf-token")).toBe(false);
  });

  it("rotates all three Keycloak cookies on a happy-path refresh", async () => {
    jar.set("givernance_jwt", "old-jwt");
    jar.set("givernance_id_token", "old-id-token");
    jar.set("givernance_refresh_token", "old-refresh");
    jar.set("csrf-token", "stable-csrf-uuid");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe(KEYCLOAK_TOKEN_URL);
        return new Response(
          JSON.stringify({
            access_token: "new-jwt",
            id_token: "new-id-token",
            refresh_token: "new-refresh",
            expires_in: 300,
            refresh_expires_in: 1800,
          }),
          { status: 200 },
        );
      }),
    );

    const res = await POST(makeRequest());
    const body = (await res.json()) as { ok?: boolean; expiresIn?: number };

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, expiresIn: 300 });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(jar.get("givernance_jwt")).toBe("new-jwt");
    expect(jar.get("givernance_id_token")).toBe("new-id-token");
    expect(jar.get("givernance_refresh_token")).toBe("new-refresh");
    // PR #360 review (Security m6): CSRF cookie value is *preserved* on
    // rotation rather than minted fresh, so in-flight client reads stay
    // consistent across the round-trip.
    expect(jar.get("csrf-token")).toBe("stable-csrf-uuid");
  });

  it("keeps the existing refresh-token cookie when Keycloak omits one", async () => {
    jar.set("givernance_refresh_token", "old-refresh-keep-me");

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ access_token: "new-jwt", expires_in: 300 }), {
            status: 200,
          }),
      ),
    );

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    expect(jar.get("givernance_jwt")).toBe("new-jwt");
    expect(jar.get("givernance_refresh_token")).toBe("old-refresh-keep-me");
  });

  it("mints a fresh CSRF token when none was set previously", async () => {
    jar.set("givernance_refresh_token", "old-refresh");
    // No csrf-token cookie pre-set.

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ access_token: "new-jwt", expires_in: 300 }), {
            status: 200,
          }),
      ),
    );

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    const minted = jar.get("csrf-token");
    expect(minted).toBeTruthy();
    expect(minted).toMatch(/^[0-9a-f-]{36}$/i); // crypto.randomUUID shape
  });

  it("401s and clears cookies when Keycloak rejects the refresh token (invalid_grant)", async () => {
    jar.set("givernance_jwt", "old-jwt");
    jar.set("givernance_id_token", "old-id-token");
    jar.set("givernance_refresh_token", "revoked-refresh");
    jar.set("csrf-token", "stale-csrf");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })),
    );

    const res = await POST(makeRequest());
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(401);
    expect(body.error).toBe("refresh_rejected");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(jar.has("givernance_jwt")).toBe(false);
    expect(jar.has("givernance_id_token")).toBe(false);
    expect(jar.has("givernance_refresh_token")).toBe(false);
    expect(jar.has("csrf-token")).toBe(false);
  });

  it("503s WITHOUT clearing cookies when Keycloak is network-unreachable", async () => {
    jar.set("givernance_jwt", "keep-me-jwt");
    jar.set("givernance_id_token", "keep-me-id");
    jar.set("givernance_refresh_token", "keep-me-refresh");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    const res = await POST(makeRequest());
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(503);
    expect(body.error).toBe("network_failure");
    expect(res.headers.get("cache-control")).toBe("no-store");
    // Cookies preserved — session may still be valid; client retries.
    expect(jar.get("givernance_jwt")).toBe("keep-me-jwt");
    expect(jar.get("givernance_id_token")).toBe("keep-me-id");
    expect(jar.get("givernance_refresh_token")).toBe("keep-me-refresh");
  });

  it("401s and clears cookies when Keycloak returns 200 with no access_token", async () => {
    jar.set("givernance_refresh_token", "old-refresh");
    jar.set("givernance_jwt", "old-jwt");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
    );

    const res = await POST(makeRequest());
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(401);
    expect(body.error).toBe("malformed_response");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(jar.has("givernance_jwt")).toBe(false);
    expect(jar.has("givernance_refresh_token")).toBe(false);
  });
});
