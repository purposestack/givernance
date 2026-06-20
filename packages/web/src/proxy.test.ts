/**
 * Tests for the Next.js 16 proxy (issue #296).
 *
 * The proxy no longer injects `Authorization` or re-writes the `cookie`
 * header, and no longer refreshes tokens inline. These tests pin the
 * observable behaviour that replaced it:
 *   - steady-state authenticated navigation passes through untouched
 *   - a protected route with an absent/expired JWT detours through
 *     `/api/auth/restore-session` (carrying the original path as `return`)
 *   - signed-in users are still bounced off `/login`
 *   - the CSRF safety-net cookie is still minted when missing
 */

import type { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { proxy } from "@/proxy";

function base64url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Build a JWT whose `exp` is `secondsFromNow` relative to the current time. */
function jwtExpiringIn(secondsFromNow: number): string {
  const exp = Math.floor(Date.now() / 1000) + secondsFromNow;
  return `header.${base64url(JSON.stringify({ exp }))}.sig`;
}

function makeRequest(pathname: string, cookies: { jwt?: string; csrf?: string } = {}): NextRequest {
  const url = `http://localhost:3000${pathname}`;
  return {
    url,
    nextUrl: new URL(url),
    cookies: {
      get: (name: string) => {
        if (name === "givernance_jwt" && cookies.jwt !== undefined) return { value: cookies.jwt };
        if (name === "csrf-token" && cookies.csrf !== undefined) return { value: cookies.csrf };
        return undefined;
      },
    },
  } as unknown as NextRequest;
}

const VALID_JWT = jwtExpiringIn(600);
const EXPIRED_JWT = jwtExpiringIn(-10);

describe("proxy (Next.js middleware)", () => {
  it("passes an authenticated protected navigation through without redirecting", async () => {
    const res = await proxy(makeRequest("/dashboard", { jwt: VALID_JWT, csrf: "csrf-1" }));
    // NextResponse.next() → not a redirect.
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("does NOT set Authorization or rewrite the cookie on a pass-through (issue #296)", async () => {
    const res = await proxy(makeRequest("/api/v1/users/me", { jwt: VALID_JWT, csrf: "csrf-1" }));
    expect(res.headers.get("location")).toBeNull();
    // The middleware-override headers that bloated the request must be absent.
    expect(res.headers.get("x-middleware-override-headers")).toBeNull();
    expect(res.headers.get("x-middleware-request-authorization")).toBeNull();
  });

  it("detours a protected route with NO jwt to restore-session, carrying the return path", async () => {
    const res = await proxy(makeRequest("/dashboard"));
    const loc = res.headers.get("location") ?? "";
    expect(loc).toContain("/api/auth/restore-session");
    expect(loc).toContain("return=%2Fdashboard");
  });

  it("detours a protected route with an EXPIRED jwt to restore-session", async () => {
    const res = await proxy(makeRequest("/settings", { jwt: EXPIRED_JWT }));
    const loc = res.headers.get("location") ?? "";
    expect(loc).toContain("/api/auth/restore-session");
    expect(loc).toContain("return=%2Fsettings");
  });

  it("preserves the query string in the restore return parameter", async () => {
    const res = await proxy(makeRequest("/dashboard?tab=2"));
    const loc = res.headers.get("location") ?? "";
    // return=/dashboard?tab=2 → encoded
    expect(loc).toContain("return=%2Fdashboard%3Ftab%3D2");
  });

  it("redirects a signed-in user away from /login to /dashboard", async () => {
    const res = await proxy(makeRequest("/login", { jwt: VALID_JWT }));
    expect(res.headers.get("location")).toBe("http://localhost:3000/dashboard");
  });

  it("does NOT bounce an expired-jwt user off /login (treated as signed-out)", async () => {
    const res = await proxy(makeRequest("/login", { jwt: EXPIRED_JWT }));
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("lets unauthenticated users reach public routes", async () => {
    const res = await proxy(makeRequest("/login"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("mints the CSRF cookie when an authenticated request arrives without one", async () => {
    const res = await proxy(makeRequest("/dashboard", { jwt: VALID_JWT }));
    expect(res.cookies.get("csrf-token")?.value).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("does not mint a CSRF cookie when one is already present", async () => {
    const res = await proxy(makeRequest("/dashboard", { jwt: VALID_JWT, csrf: "existing" }));
    expect(res.cookies.get("csrf-token")).toBeUndefined();
  });
});
