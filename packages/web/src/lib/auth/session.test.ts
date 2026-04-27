import { decodeJwtExp, resolveSessionMaxAge, shouldRefreshToken } from "@/lib/auth/session";

function buildToken(payload: Record<string, unknown>) {
  const encoded = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
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
});
