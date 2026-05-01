import { describe, expect, it } from "vitest";
import { isUniqueViolation } from "./db-errors.js";

// Mirrors drizzle-orm 0.45's `DrizzleQueryError` shape: a wrapper class with
// only `query`, `params`, `message`, and `cause`. The original pg error
// (carrying `.code`, `.constraint`, `.message`) lives on `.cause`. This is the
// shape every `db.execute(sql\`...\`)` / `db.insert().values()` rejection
// adopts in production.
class WrappedError extends Error {
  constructor(
    message: string,
    readonly cause: unknown,
  ) {
    super(message);
  }
}

describe("isUniqueViolation", () => {
  it("returns true for a raw pg unique-violation (pre-0.45 shape)", () => {
    const raw = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "tenants_slug_uniq",
    });
    expect(isUniqueViolation(raw)).toBe(true);
  });

  it("returns true for a drizzle-orm 0.45+ wrapped unique-violation", () => {
    const cause = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "tenants_slug_uniq",
    });
    const wrapped = new WrappedError("Failed query: ...", cause);
    expect(isUniqueViolation(wrapped)).toBe(true);
  });

  it("matches the constraintHint against the wrapped pg error", () => {
    const cause = Object.assign(new Error("duplicate key on users_email_lower_uniq"), {
      code: "23505",
      constraint: "users_email_lower_uniq",
    });
    const wrapped = new WrappedError("Failed query: ...", cause);
    expect(isUniqueViolation(wrapped, /users_email_lower_uniq/)).toBe(true);
    expect(isUniqueViolation(wrapped, /tenants_slug_uniq/)).toBe(false);
  });

  it("returns false when the wrapped pg error has a different SQLSTATE", () => {
    const cause = Object.assign(new Error("check violation"), {
      code: "23514",
      constraint: "tenants_status_chk",
    });
    const wrapped = new WrappedError("Failed query: ...", cause);
    expect(isUniqueViolation(wrapped)).toBe(false);
  });

  it("returns false for non-error inputs", () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
    expect(isUniqueViolation({})).toBe(false);
  });
});
