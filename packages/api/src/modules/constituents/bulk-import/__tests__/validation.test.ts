/**
 * Unit tests for per-row validation.
 *
 * Pure-function coverage — no DB, no S3. Each test asserts both the
 * outcome flag (`ok`) and (for failures) the stable error code that
 * the operator-facing CSV download surfaces.
 */

import { describe, expect, it } from "vitest";
import { hasCompleteAddress, validateRow } from "../validation.js";

describe("validateRow", () => {
  it("returns ok for a minimal valid row", () => {
    const out = validateRow({ firstName: "Alice", lastName: "Martin" });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.payload.firstName).toBe("Alice");
      expect(out.payload.lastName).toBe("Martin");
      expect(out.payload.email).toBeUndefined();
    }
  });

  it("requires both firstName and lastName", () => {
    const out = validateRow({});
    expect(out.ok).toBe(false);
    if (!out.ok) {
      const codes = out.errors.map((e) => e.code);
      expect(codes).toContain("REQUIRED_FIRST_NAME");
      expect(codes).toContain("REQUIRED_LAST_NAME");
    }
  });

  it("rejects an invalid email format", () => {
    const out = validateRow({ firstName: "A", lastName: "B", email: "not-an-email" });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.errors.map((e) => e.code)).toContain("INVALID_EMAIL");
    }
  });

  it("accepts a well-formed email", () => {
    const out = validateRow({ firstName: "A", lastName: "B", email: "a.b@example.com" });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.payload.email).toBe("a.b@example.com");
  });

  it("rejects non-ISO country codes", () => {
    const out = validateRow({ firstName: "A", lastName: "B", countryCode: "France" });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.errors.map((e) => e.code)).toContain("INVALID_COUNTRY_CODE");
    }
  });

  it("uppercases a lowercase 2-letter country code", () => {
    const out = validateRow({ firstName: "A", lastName: "B", countryCode: "fr" });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.payload.countryCode).toBe("FR");
  });

  it("rejects an unknown constituent type", () => {
    const out = validateRow({ firstName: "A", lastName: "B", type: "sponsor" });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.errors.map((e) => e.code)).toContain("INVALID_TYPE");
    }
  });

  it("accepts a valid type, case-insensitively", () => {
    const out = validateRow({ firstName: "A", lastName: "B", type: "Donor" });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.payload.types).toEqual(["donor"]);
  });

  it("splits a multi-value type cell and deduplicates (issue #465)", () => {
    const out = validateRow({ firstName: "A", lastName: "B", type: "donor; Volunteer|donor" });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.payload.types).toEqual(["donor", "volunteer"]);
  });

  it("rejects the whole row when any type in a multi-value cell is invalid", () => {
    const out = validateRow({ firstName: "A", lastName: "B", type: "donor;sponsor" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors.map((e) => e.code)).toContain("INVALID_TYPE");
  });

  it("splits comma-separated tags and deduplicates", () => {
    const out = validateRow({
      firstName: "A",
      lastName: "B",
      tags: "vip, monthly,vip, newsletter",
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.payload.tags).toEqual(["vip", "monthly", "newsletter"]);
    }
  });

  it("flags FIELD_TOO_LONG when firstName exceeds 255 chars", () => {
    const out = validateRow({ firstName: "A".repeat(256), lastName: "B" });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.errors.map((e) => e.code)).toContain("FIELD_TOO_LONG");
    }
  });
});

describe("hasCompleteAddress", () => {
  it("returns true only when all four fields are populated", () => {
    expect(
      hasCompleteAddress({
        firstName: "A",
        lastName: "B",
        addressLine1: "1 Main",
        postalCode: "75001",
        city: "Paris",
        countryCode: "FR",
      }),
    ).toBe(true);
    expect(
      hasCompleteAddress({
        firstName: "A",
        lastName: "B",
        addressLine1: "1 Main",
        postalCode: "75001",
        city: "Paris",
      }),
    ).toBe(false);
    expect(hasCompleteAddress({ firstName: "A", lastName: "B" })).toBe(false);
  });
});
