import {
  authScopedCookieOptions,
  decodeJwtExp,
  isJwtExpired,
  jwtCookieOptions,
  resolveSessionMaxAge,
  shouldRefreshToken,
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

  it("decodes JWT expiry and refreshes only near expiration", () => {
    const token = buildToken({ exp: 2_000 });

    expect(decodeJwtExp(token)).toBe(2_000);
    expect(shouldRefreshToken(token, 1_500, 60)).toBe(false);
    expect(shouldRefreshToken(token, 1_950, 60)).toBe(true);
  });

  it("isJwtExpired uses hard expiry, not the refresh grace window (issue #296)", () => {
    const token = buildToken({ exp: 2_000 });

    // Absent token is treated as expired (forces the restore-session detour).
    expect(isJwtExpired(undefined)).toBe(true);
    // Still valid one second before exp — even though shouldRefreshToken
    // (5-min grace) would already be true on a short-lived token.
    expect(isJwtExpired(token, 1_999)).toBe(false);
    expect(shouldRefreshToken(token, 1_999, 300)).toBe(true);
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
