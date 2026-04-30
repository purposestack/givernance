/**
 * Unit tests for the minimal feature-flag resolver (issue #62).
 *
 * The resolver is the linchpin for both the gateway factory's
 * `mollie_flag_off` rejection and the org-admin PATCH route's
 * "Mollie is not enabled" 400 — pinning its behaviour at the unit
 * level catches regressions that would otherwise only surface via
 * integration paths.
 */

import { describe, expect, it } from "vitest";
import { hasFeatureFlag } from "./feature-flags.js";

describe("hasFeatureFlag", () => {
  it("returns false when featureFlags is an empty object", () => {
    expect(hasFeatureFlag({ featureFlags: {} }, "ff.payments.mollie")).toBe(false);
  });

  it("returns true when the key is explicitly true", () => {
    expect(
      hasFeatureFlag({ featureFlags: { "ff.payments.mollie": true } }, "ff.payments.mollie"),
    ).toBe(true);
  });

  it("returns false when the key is explicitly false", () => {
    expect(
      hasFeatureFlag({ featureFlags: { "ff.payments.mollie": false } }, "ff.payments.mollie"),
    ).toBe(false);
  });

  it("returns false for non-strict-true values (defends against string coercion)", () => {
    // JSONB columns can occasionally end up with string values from a
    // hand-crafted UPDATE statement. The strict `=== true` check is the
    // last line of defence — `"true"`, `1`, `[true]` must NOT activate
    // the gate.
    const cases: unknown[] = ["true", 1, "1", [true], { value: true }];
    for (const value of cases) {
      const tenant = {
        featureFlags: { "ff.payments.mollie": value } as unknown as Partial<
          Record<"ff.payments.mollie", boolean>
        >,
      };
      expect(hasFeatureFlag(tenant, "ff.payments.mollie")).toBe(false);
    }
  });

  it("returns false when featureFlags is null/undefined (defensive)", () => {
    // Drizzle types it as non-null (DB default `'{}'::jsonb`), but the
    // helper accepts the broader shape so a partial test fixture or a
    // `SELECT` that omits the column doesn't crash.
    expect(
      hasFeatureFlag(
        { featureFlags: null as unknown as Partial<Record<"ff.payments.mollie", boolean>> },
        "ff.payments.mollie",
      ),
    ).toBe(false);
  });
});
