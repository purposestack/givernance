import { describe, expect, it } from "vitest";

import { RETURN_TO_PATH_ALLOWLIST } from "./return-to-allowlist";

/**
 * The post-logout `return_to` allowlist gates which in-app paths can be
 * used as the destination after Keycloak's end-session redirect. Each
 * accept-style flow that relies on the round-trip MUST appear here —
 * see issue #254 for the bug class (the platform-admin accept page
 * silently fell back to /login because the path was missing, losing
 * the invitation token and stranding the new admin without a password).
 *
 * `parsed.pathname` is exact-matched in `resolvePostLogoutRedirectUri`,
 * so additions here are the only knob for new round-trip targets.
 */
describe("logout route — return_to allowlist", () => {
  it("includes /invite/accept (team invitation flow, PR #154)", () => {
    expect(RETURN_TO_PATH_ALLOWLIST.has("/invite/accept")).toBe(true);
  });

  it("includes /admin/platform-admins/accept (platform-admin invitation flow, issue #254)", () => {
    expect(RETURN_TO_PATH_ALLOWLIST.has("/admin/platform-admins/accept")).toBe(true);
  });

  it("does NOT include /login or arbitrary paths (anti-open-redirect)", () => {
    expect(RETURN_TO_PATH_ALLOWLIST.has("/login")).toBe(false);
    expect(RETURN_TO_PATH_ALLOWLIST.has("/admin")).toBe(false);
    expect(RETURN_TO_PATH_ALLOWLIST.has("/")).toBe(false);
    expect(RETURN_TO_PATH_ALLOWLIST.has("/admin/tenants")).toBe(false);
  });
});
