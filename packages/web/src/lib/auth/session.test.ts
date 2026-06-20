import {
  authScopedCookieOptions,
  decodeJwtExp,
  isJwtExpired,
  jwtCookieOptions,
  resolveSessionMaxAge,
} from "@/lib/auth/session";

function buildToken(payload: Record<string, unknown>) {
  const encoded = btoa(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `header.${encoded}.signature`;
}

describe("auth session helpers", () => {
  it("prefers the refresh-token TTL for the browser session", () => {
    expect(resolveSessionMaxAge({ expires_in: 300, refresh_expires_in: 3600 })).toBe(3600);
  });

  it("falls back to the access-token TTL when no refresh TTL is present", () => {
    expect(resolveSessionMaxAge({ expires_in: 900 })).toBe(900);
  });

  it("decodes JWT expiry from the payload", () => {
    expect(decodeJwtExp(buildToken({ exp: 2_000 }))).toBe(2_000);
    expect(decodeJwtExp("not-a-jwt")).toBeUndefined();
    expect(decodeJwtExp(buildToken({ sub: "x" }))).toBeUndefined();
  });

  it("isJwtExpired uses hard expiry, not a near-expiry grace window (issue #296)", () => {
    const token = buildToken({ exp: 2_000 });

    // Absent token is treated as expired (forces the restore-session detour).
    expect(isJwtExpired(undefined)).toBe(true);
    // Still valid one second before exp.
    expect(isJwtExpired(token, 1_999)).toBe(false);
    // Expired exactly at and past exp.
    expect(isJwtExpired(token, 2_000)).toBe(true);
    expect(isJwtExpired(token, 2_001)).toBe(true);
    // No decodable exp → not-expired (API is the authority).
    expect(isJwtExpired(buildToken({ sub: "x" }), 9_999)).toBe(false);
  });

  it("authScopedCookieOptions narrows path to /api/auth, keeps security flags", () => {
    const scoped = authScopedCookieOptions(1_800);
    const root = jwtCookieOptions(1_800);

    expect(scoped.path).toBe("/api/auth");
    expect(root.path).toBe("/");
    // Only the path differs from the root session cookie options.
    expect(scoped.httpOnly).toBe(root.httpOnly);
    expect(scoped.sameSite).toBe(root.sameSite);
    expect(scoped.secure).toBe(root.secure);
    expect(scoped.maxAge).toBe(1_800);
  });
});
