import { describe, expect, it } from "vitest";

import { validateLoginHint } from "./login-hint";

describe("validateLoginHint", () => {
  // The validator delegates to the canonical `validateTenantSlug`, so its
  // shape rules — regex, 2–50 char length, `xn--` punycode reject, and
  // the reserved-slug list — are inherited. The cases below cover the
  // discriminated-result contract the login route now consumes.

  it("returns `valid` with the canonical (trimmed + lowercased) slug for accepted shapes", () => {
    expect(validateLoginHint("acme")).toEqual({ kind: "valid", slug: "acme" });
    expect(validateLoginHint("foo-bar")).toEqual({ kind: "valid", slug: "foo-bar" });
    expect(validateLoginHint("  Acme-Foundation  ")).toEqual({
      kind: "valid",
      slug: "acme-foundation",
    });
  });

  it("returns `absent` when the input is missing or empty (no warn log fires)", () => {
    expect(validateLoginHint(null)).toEqual({ kind: "absent" });
    expect(validateLoginHint(undefined)).toEqual({ kind: "absent" });
    expect(validateLoginHint("")).toEqual({ kind: "absent" });
    expect(validateLoginHint("   ")).toEqual({ kind: "absent" });
  });

  it("returns `rejected` with `syntax` for shape violations", () => {
    expect(validateLoginHint("a")).toEqual({ kind: "rejected", reason: "syntax" });
    expect(validateLoginHint("-acme")).toEqual({ kind: "rejected", reason: "syntax" });
    expect(validateLoginHint("acme-")).toEqual({ kind: "rejected", reason: "syntax" });
    expect(validateLoginHint("Acme Foundation")).toEqual({
      kind: "rejected",
      reason: "syntax",
    });
    expect(validateLoginHint("acme/etc")).toEqual({ kind: "rejected", reason: "syntax" });
    expect(validateLoginHint("acme&kc_idp_hint=other")).toEqual({
      kind: "rejected",
      reason: "syntax",
    });
    expect(validateLoginHint("a".repeat(51))).toEqual({ kind: "rejected", reason: "syntax" });
  });

  it("returns `rejected` with `punycode` for IDNA-prefixed values", () => {
    // Without delegation to validateTenantSlug, a local regex would
    // accept `xn--paypal` as a valid slug shape and forward it to
    // Keycloak as a `kc_idp_hint` value — low blast radius but exactly
    // the kind of probe the multi-agent review M7 flagged. Pinning the
    // reason discriminator here so a future regression is loud.
    expect(validateLoginHint("xn--paypal")).toEqual({ kind: "rejected", reason: "punycode" });
  });

  it("returns `rejected` with `reserved` for platform-reserved slugs", () => {
    // `admin`, `api`, `www`, … are reserved by the platform (see
    // `packages/shared/src/constants/reserved-slugs.ts`). Forwarding
    // them as a hint to KC is harmless (no IdP alias will match) but
    // probing for them belongs in the warn log, not the upstream URL.
    expect(validateLoginHint("admin")).toEqual({ kind: "rejected", reason: "reserved" });
    expect(validateLoginHint("api")).toEqual({ kind: "rejected", reason: "reserved" });
  });
});
