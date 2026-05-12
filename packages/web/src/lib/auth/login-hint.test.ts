import { describe, expect, it } from "vitest";

import { validateLoginHint } from "./login-hint";

describe("validateLoginHint", () => {
  // Accepted shapes mirror `validateTenantSlug` (shared/validators) — the
  // signup-verify and invite-accept pages forward `response.slug` directly,
  // so the accept criteria here is "round-trips a server-issued slug".
  it("accepts canonical lowercase slugs", () => {
    expect(validateLoginHint("acme")).toBe("acme");
    expect(validateLoginHint("foo-bar")).toBe("foo-bar");
    expect(validateLoginHint("a1")).toBe("a1");
  });

  it("normalises trimmed + mixed-case input", () => {
    expect(validateLoginHint("  Acme-Foundation  ")).toBe("acme-foundation");
  });

  it("returns null when absent", () => {
    expect(validateLoginHint(null)).toBeNull();
    expect(validateLoginHint(undefined)).toBeNull();
    expect(validateLoginHint("")).toBeNull();
  });

  // Each rejection below would otherwise reach Keycloak as a literal
  // `kc_idp_hint` value and probe for alias matches. Dropping them
  // server-side keeps upstream logs free of attacker probes.
  it("rejects single-character slugs (< 2 chars violates the shared pattern)", () => {
    expect(validateLoginHint("a")).toBeNull();
  });

  it("rejects leading or trailing hyphens", () => {
    expect(validateLoginHint("-acme")).toBeNull();
    expect(validateLoginHint("acme-")).toBeNull();
  });

  it("rejects uppercase that doesn't normalise to a valid slug", () => {
    // Uppercase WITH characters that don't survive lowercasing (e.g. spaces)
    expect(validateLoginHint("Acme Foundation")).toBeNull();
  });

  it("rejects slug-injection attempts (spaces, slashes, query separators)", () => {
    expect(validateLoginHint("acme/etc")).toBeNull();
    expect(validateLoginHint("acme&kc_idp_hint=other")).toBeNull();
    expect(validateLoginHint("acme?x=1")).toBeNull();
    expect(validateLoginHint("acme foundation")).toBeNull();
  });

  it("rejects slugs longer than the 50-char shared cap", () => {
    const tooLong = "a".repeat(51);
    expect(validateLoginHint(tooLong)).toBeNull();
  });
});
