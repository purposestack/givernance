/**
 * `buildLoginHref` (issue #613) — the login page forwards the
 * `?redirect=` it received from `/api/auth/restore-session` to the login
 * route as `return_to`, after a client-side shape check. The server-side
 * `safeReturnToPath` remains the authority.
 */

import { describe, expect, it } from "vitest";
import { buildLoginHref } from "./login-redirect";

describe("buildLoginHref", () => {
  it("forwards a same-origin path as return_to, query string included", () => {
    expect(buildLoginHref("/constituents?page=2&q=marie")).toBe(
      "/api/auth/login?return_to=%2Fconstituents%3Fpage%3D2%26q%3Dmarie",
    );
  });

  it.each([
    ["missing", null],
    ["empty", ""],
    ["absolute URL", "https://evil.example/phish"],
    ["protocol-relative", "//evil.example/phish"],
    ["backslash protocol-relative", "/\\evil.example"],
    ["relative path", "dashboard"],
    ["javascript: scheme", "javascript:alert(1)"],
    ["CRLF injection", "/dashboard\r\nSet-Cookie: x=1"],
    ["oversized", `/${"a".repeat(3000)}`],
  ])("drops a %s redirect and falls back to the bare login route", (_label, value) => {
    expect(buildLoginHref(value)).toBe("/api/auth/login");
  });
});
